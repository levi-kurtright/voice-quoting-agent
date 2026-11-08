// Summit Office Supply: Stripe Billing service behind the Quinn and Riley voice agents (Val Town HTTP val).
//
// Modules
//   stripe_endpoints.ts  router + quotes, invoices, subscriptions, proration, promo codes, credit notes, status
//   core.ts              shared Stripe helpers (client, money/date formatting, customer and invoice lookup)
//   print.ts             managed print plans on Stripe Billing meters, plan switches, test-clock demo
//   recovery.ts          failed card payments, Stripe retries, recovery test-clock demo
//   followups.ts         tracked specialist follow-ups + Stripe activity log (Val Town SQLite), GET /followups
//   native.ts            Stripe webhooks, prepaid print credits (Billing credit grants), Stripe Tax + webhook setup
//   dashboard.ts         GET /dashboard: live revenue view from Stripe and the call logs
//
// Routes (POST unless noted). Every spoken answer is built from Stripe's own fields.
//   /                     Quinn  create an invoice (+ subscription) directly from a confirmed quote
//   /quote                Quinn  create a finalized Stripe Quote (Stripe Tax from the ship-to ZIP), optional promo code
//   /quote/accept         Quinn  accept a quote; Stripe generates the invoice and subscription
//   GET /quote-pdf/:id           Stripe-rendered quote PDF
//   /promo/check          Quinn  validate a promotion code (read-only)
//   /subscription/preview Quinn  price a quantity change with Stripe proration (read-only)
//   /subscription/change  Quinn  apply it; prorated difference invoiced immediately
//   /usage/plan-options   Quinn  compare this period on the 5K and 25K print plans (read-only)
//   /usage/plan-change    Quinn  switch print plans at the next billing period (subscription schedule)
//   /status               Riley  invoice status, usage breakdown, failed-payment explanation (read-only)
//   /subscriptions        Riley  subscription details (read-only)
//   /usage                Riley  print usage this period + Stripe's next-invoice preview (read-only)
//   /credit/preview       Riley  preview a credit note against phone policy (read-only)
//   /credit/issue         Riley  issue the credit note after the caller confirms
//   /credits/buy          Quinn  sell prepaid print credit (reads back first; creates the invoice on confirmed: true)
//   /credits              Riley  prepaid print credit balance from Stripe Billing credits (read-only)
//   /payment/link         Riley  have Stripe email the invoice's secure payment page to the billing email on file
//   /payment/retry        Riley  after the owner updates the card, have Stripe retry a failed charge now (confirmed: true)
//   /followup             both   log a tracked specialist follow-up;  GET /followups lists them
//   /stripe/webhook       Stripe invoice.paid / invoice.payment_failed -> follow-ups, credit grants, activity log
//   GET /dashboard               live revenue dashboard
//   /usage/setup, /usage/report, /demo/clock, /demo/dunning, /demo/stripe-setup, /demo/pay-invoice   admin + simulated printer feed (test mode)
//
// Requires env var:  STRIPE_SECRET_KEY = sk_test_...   (TEST mode). Never hard-code it.
// Write calls use Stripe idempotency keys, so a retried "yes" never bills twice.

import { Stripe, asDate, cents, findCustomer, findInvoiceByNumber, getStripe, money, productFor } from "./core.ts";
import { followupsPage, logFollowUp } from "./followups.ts";
import { changePrintPlan, demoClock, explainUsageInvoice, lookupPrintUsage, printPlanOptions, reportPrintUsage, setupPrintPlan } from "./print.ts";
import { demoDunning, paymentFailureLine, retryPayment, sendPaymentLink } from "./recovery.ts";
import { buyPrintCredits, demoPayInvoice, handleStripeWebhook, lookupPrintCredits, stripeSetup, taxActive } from "./native.ts";
import { dashboardPage } from "./dashboard.ts";

/* ---------------------------------------------------------------- Quinn: create invoice */

type Line = { product: string; qty: number; unit_net: number; billing: "one_time" | "monthly"; volume_discount_pct?: number; extra_discount_pct?: number; };

function describe(l: Line): string {
  const d: string[] = [];
  if (l.volume_discount_pct) d.push(`${l.volume_discount_pct}% volume`);
  if (l.extra_discount_pct) d.push(`${l.extra_discount_pct}% extra`);
  return d.length ? `${l.product} (${d.join(", ")} discount)` : l.product;
}

// Duplicate protection (a caller saying "yes" twice, or a retried tool call, must not double-bill):
//   1. Before writing anything, look for an invoice/subscription already tagged with this quote_id.
//   2. Every write carries an idempotency key derived from the quote_id, so concurrent or
//      retried requests within Stripe's 24h window return the original objects instead of new ones.
async function findExistingForQuote(stripe: Stripe, quoteId: string) {
  const q = `metadata['quote_id']:'${quoteId.replace(/'/g, "")}'`;
  const [inv, sub] = await Promise.all([
    stripe.invoices.search({ query: q, limit: 1 }).catch(() => null),
    stripe.subscriptions.search({ query: q, limit: 1 }).catch(() => null),
  ]);
  return { invoice: inv?.data[0], subscription: sub?.data[0] };
}

async function createInvoice(body: any) {
  const stripe = getStripe();
  const dealer = body?.dealer ?? {};
  const lines: Line[] = Array.isArray(body?.lines) ? body.lines : [];
  const quoteId: string = String(body?.quote_id ?? "").trim();
  if (!quoteId) throw new Error("quote_id is required, pass the quote_id returned by calculate_quote");
  if (!lines.length) throw new Error("No lines to invoice");

  const existing = await findExistingForQuote(stripe, quoteId);
  if (existing.invoice || existing.subscription) {
    const inv = existing.invoice;
    return {
      ok: true, already_invoiced: true, quote_id: quoteId,
      invoice_number: inv?.number ?? null, hosted_invoice_url: inv?.hosted_invoice_url ?? null,
      subscription_id: existing.subscription?.id ?? null,
      spoken_summary: `Quote ${quoteId} has already been invoiced${inv?.number ? ` as invoice ${inv.number} for ${money(inv.total)}` : ""}, so I haven't created a duplicate.`,
    };
  }

  const key = (step: string) => ({ idempotencyKey: `quinn:${quoteId}:${step}` });

  try {
    return await createForQuote(stripe, quoteId, dealer, lines, key);
  } catch (e) {
    if ((e as any)?.type === "StripeIdempotencyError") {
      return {
        ok: false, already_invoiced: true, quote_id: quoteId,
        spoken_summary: `Quote ${quoteId} was already submitted with different details. I've stopped so it isn't billed twice. A billing specialist will follow up.`,
      };
    }
    throw e;
  }
}

type KeyFn = (s: string) => { idempotencyKey: string };

async function findOrCreateCustomer(stripe: Stripe, dealer: any, key: KeyFn): Promise<Stripe.Customer> {
  if (dealer?.id) {
    const found = await stripe.customers.search({ query: `metadata['dealer_id']:'${String(dealer.id).replace(/'/g, "")}'`, limit: 1 });
    if (found.data[0]) return found.data[0];
  }
  return await stripe.customers.create({
    name: dealer?.name, email: dealer?.email, phone: dealer?.phone,
    metadata: { dealer_id: dealer?.id ?? "", source: "quinn_voice_agent" },
  }, key("customer"));
}

async function createForQuote(stripe: Stripe, quoteId: string, dealer: any, lines: Line[], key: KeyFn) {
  const customer = await findOrCreateCustomer(stripe, dealer, key);

  const oneTime = lines.filter((l) => l.billing === "one_time");
  const monthly = lines.filter((l) => l.billing === "monthly");

  let invoice: Stripe.Invoice | undefined;
  if (oneTime.length) {
    // Create the draft first, then attach items directly to it, so items can never
    // leak onto some other pending invoice for the same customer.
    const draft = await stripe.invoices.create({
      customer: customer.id, collection_method: "send_invoice", days_until_due: 30,
      pending_invoice_items_behavior: "exclude",
      description: "Order placed by phone via Quinn, the Summit Office Supply voice quoting agent.",
      footer: `Quote ${quoteId} · prices exclude tax`,
      metadata: { quote_id: quoteId, source: "quinn_voice_agent" },
    }, key("invoice"));
    for (const [i, l] of oneTime.entries()) {
      await stripe.invoiceItems.create({
        customer: customer.id, invoice: draft.id, currency: "usd",
        quantity: l.qty, unit_amount_decimal: String(cents(l.unit_net)), description: describe(l),
      }, key(`item:${i}`));
    }
    invoice = await stripe.invoices.finalizeInvoice(draft.id, {}, key("finalize"));
  }

  let subscription: Stripe.Subscription | undefined;
  if (monthly.length) {
    const items = [];
    for (const [i, l] of monthly.entries()) {
      const price = await stripe.prices.create({
        currency: "usd", unit_amount: cents(l.unit_net), recurring: { interval: "month" },
        product_data: { name: l.product }, metadata: { source: "quinn_voice_agent" },
      }, key(`price:${i}`));
      items.push({ price: price.id, quantity: l.qty });
    }
    subscription = await stripe.subscriptions.create({
      customer: customer.id, items, collection_method: "send_invoice", days_until_due: 30,
      metadata: { quote_id: quoteId, source: "quinn_voice_agent", term_months: "12" },
    }, key("subscription"));
  }

  const oneTimeTotal = (invoice?.total ?? 0) / 100;
  const monthlyTotal = monthly.reduce((s, l) => s + l.unit_net * l.qty, 0);
  return {
    ok: true, customer_id: customer.id,
    invoice_number: invoice?.number ?? null,
    hosted_invoice_url: invoice?.hosted_invoice_url ?? null,
    invoice_pdf: invoice?.invoice_pdf ?? null,
    one_time_total: oneTimeTotal,
    subscription_id: subscription?.id ?? null,
    monthly_recurring_total: monthlyTotal,
    spoken_summary:
      (invoice ? `Invoice ${invoice.number} for ${money((invoice.total))} is on its way with a pay-online link. ` : "") +
      (subscription ? `Your toner subscription of ${money(cents(monthlyTotal))} a month is set up and billed monthly.` : ""),
  };
}

/* ------------------------------------------------- Quinn: formal Stripe Quotes (quote -> accept -> bill) */
//
// The Stripe-native quote-to-cash path. send_quote turns a priced order into a finalized Stripe Quote
// (quote number, expiry, PDF). accept_quote accepts it, and Stripe itself generates the billing:
// an invoice for one-time lines, or a subscription (whose first invoice carries the one-time lines too).
// A caller can accept on the same call or call back later with the quote number.

let ORIGIN = ""; // set per request by the router, used to build PDF links



function quoteFacts(q: Stripe.Quote) {
  const upfront = q.computed?.upfront?.amount_total ?? q.amount_total ?? 0;
  const monthly = q.computed?.recurring?.amount_total ?? 0;
  const discount = q.computed?.upfront?.total_details?.amount_discount ?? q.total_details?.amount_discount ?? 0;
  const taxFirst = q.computed?.upfront?.total_details?.amount_tax ?? q.total_details?.amount_tax ?? 0;
  const taxMonthly = q.computed?.recurring?.total_details?.amount_tax ?? 0;
  return {
    tax_enabled: !!q.automatic_tax?.enabled, tax_first_invoice: taxFirst / 100, tax_monthly: taxMonthly / 100,
    one_time_before_tax: ((upfront - taxFirst) - (monthly - taxMonthly)) / 100, monthly_before_tax: (monthly - taxMonthly) / 100,
    quote_number: q.number, stripe_quote_id: q.id, status: q.status,
    one_time_total: (upfront - monthly) / 100, monthly_total: monthly / 100,
    first_invoice_total: upfront / 100, first_invoice_discount: discount / 100,
    promo_code: q.metadata?.promo_code || null, valid_until: asDate(q.expires_at),
    quote_pdf_url: ORIGIN ? `${ORIGIN}/quote-pdf/${q.id}` : null,
  };
}

/* ---------------------------------------------------------- Quinn: promotion codes (Stripe-validated) */
//
// Quinn never invents a discount. A caller's code must exist in Stripe as an active promotion code and pass
// its rules (expiry, redemption limit, minimum order, first-order-only). One code per quote.

const spokenCode = (s: string) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");

function describeCoupon(c: Stripe.Coupon): string {
  const off = c.percent_off ? `${c.percent_off}% off` : `${money(c.amount_off ?? 0)} off`;
  const when = c.duration === "once" ? "the first invoice"
    : c.duration === "repeating" ? `each invoice for ${c.duration_in_months} months` : "every invoice";
  return `${off} ${when}`;
}

async function resolvePromo(stripe: Stripe, rawCode: string, customer: Stripe.Customer | null, orderCents: number | null) {
  const code = spokenCode(rawCode);
  if (!code) return { valid: false as const, code, reason: "No promo code was given." };
  const list = await stripe.promotionCodes.list({ code, limit: 5 });
  const pc = list.data.find((p) => p.code.toUpperCase() === code);
  if (!pc) return { valid: false as const, code, reason: `I don't see a promo code ${code} on file. Could you read it to me again?` };
  const raw: any = (pc as any).coupon ?? (pc as any).promotion?.coupon;
  const coupon: Stripe.Coupon = typeof raw === "string" ? await stripe.coupons.retrieve(raw) : raw;
  const r = pc.restrictions ?? ({} as Stripe.PromotionCode.Restrictions);
  const no = (reason: string) => ({ valid: false as const, code, reason });
  if (!pc.active || !coupon?.valid) return no(`Promo code ${code} is no longer active, so I can't apply it.`);
  if (pc.expires_at && pc.expires_at * 1000 < Date.now()) return no(`Promo code ${code} expired on ${asDate(pc.expires_at)}.`);
  if (pc.max_redemptions && pc.times_redeemed >= pc.max_redemptions) return no(`Promo code ${code} has reached its redemption limit.`);
  if (pc.customer && pc.customer !== customer?.id) return no(`Promo code ${code} is reserved for a different account.`);
  if (r.minimum_amount && orderCents != null && orderCents < r.minimum_amount)
    return no(`Promo code ${code} needs an order of at least ${money(r.minimum_amount)}. This order is ${money(orderCents)}.`);
  if (r.first_time_transaction && customer) {
    const paid = await stripe.invoices.list({ customer: customer.id, status: "paid", limit: 1 });
    if (paid.data.length) return no(`Promo code ${code} is only for a dealer's first order, and this account already has order history.`);
  }
  const terms = describeCoupon(coupon);
  const min = r.minimum_amount ? ` on orders of ${money(r.minimum_amount)} or more` : "";
  return { valid: true as const, code, promotion_code_id: pc.id, coupon_id: coupon.id, terms, coupon,
    description: `${coupon.name ?? code}: ${terms}${min}${r.first_time_transaction ? ", first order only" : ""}${pc.expires_at ? `, valid through ${asDate(pc.expires_at)}` : ""}` };
}

const orderCentsOf = (lines: Line[]) => lines.reduce((s, l) => s + cents(l.unit_net) * Number(l.qty || 0), 0);

// POST /promo/check  { code, dealer?, lines? }  -> read-only validation Quinn can use before quoting
async function checkPromo(body: any) {
  const stripe = getStripe();
  const lines: Line[] = Array.isArray(body?.lines) ? body.lines : [];
  const customer = body?.dealer ? await findCustomer(stripe, body.dealer) : null;
  const p = await resolvePromo(stripe, body?.code, customer, lines.length ? orderCentsOf(lines) : null);
  if (!p.valid) return { ok: true, valid: false, code: p.code, spoken_summary: p.reason };
  return { ok: true, valid: true, code: p.code, terms: p.terms, description: p.description,
    spoken_summary: `Promo code ${p.code} is valid: ${p.description}. I'll apply it to your quote, and the quote will show the exact savings.` };
}

async function createStripeQuote(body: any) {
  const stripe = getStripe();
  const dealer = body?.dealer ?? {};
  const lines: Line[] = Array.isArray(body?.lines) ? body.lines : [];
  const quoteId: string = String(body?.quote_id ?? "").trim();
  if (!quoteId) throw new Error("quote_id is required, pass the quote_id returned by calculate_quote");
  if (!lines.length) throw new Error("No lines to quote");
  const promoWanted = spokenCode(body?.promo_code ?? "");
  const customerKey: KeyFn = (step) => ({ idempotencyKey: `quinn:${quoteId}:${step}` });

  const customer = await findOrCreateCustomer(stripe, dealer, customerKey);

  // Stripe Tax needs the ship-to location. Quinn asks for the ZIP code; Stripe validates it before we quote.
  const taxOn = await taxActive(stripe);
  if (taxOn) {
    const zip = String(dealer?.postal_code ?? "").replace(/[^0-9]/g, "").slice(0, 5);
    const spokenZip = zip.split("").join(" ");
    if (zip.length === 5 && zip !== customer.address?.postal_code) {
      try {
        await stripe.customers.update(customer.id, { address: { country: "US", postal_code: zip }, tax: { validate_location: "immediately" } });
        customer.address = { ...(customer.address ?? {}), country: "US", postal_code: zip } as Stripe.Address;
      } catch (_e) {
        return { ok: true, needs_postal_code: true, spoken_summary: `I couldn't match ZIP code ${spokenZip} for sales tax. Could you read me the ZIP code the order ships to again?` };
      }
    } else if (!customer.address?.postal_code) {
      return { ok: true, needs_postal_code: true, spoken_summary: `Before I write up the quote, what's the ZIP code the order ships to? I need it to calculate sales tax.` };
    }
  }

  // Validate the promo before touching the quote, so a bad code never replaces a good quote.
  let promo: Awaited<ReturnType<typeof resolvePromo>> | null = null;
  if (promoWanted) {
    promo = await resolvePromo(stripe, promoWanted, customer, orderCentsOf(lines));
    if (!promo.valid) return { ok: true, promo_applied: false, code: promo.code, spoken_summary: `${promo.reason} I haven't changed the quote.` };
  }

  // One Stripe quote per priced order and promo: reuse it if it already exists. If the caller adds or
  // changes a promo on an open quote, cancel the old one so only one live quote exists for the order.
  const recent = await stripe.quotes.list({ customer: customer.id, limit: 100 });
  // Version the idempotency key by how many Stripe quotes this order already has (canceled ones included), so
  // switching back to a promo used earlier creates a fresh quote instead of replaying the canceled one.
  const version = recent.data.filter((q) => q.metadata?.quote_id === quoteId).length;
  const key: KeyFn = (step) => ({ idempotencyKey: `quinn:${quoteId}:${promoWanted || "nopromo"}:v${version}:${step}` });
  const same = recent.data.filter((q) => q.metadata?.quote_id === quoteId && q.status !== "canceled");
  const prior = same.find((q) => (q.metadata?.promo_code || "") === promoWanted);
  if (prior) {
    const f = quoteFacts(prior);
    return { ok: true, already_quoted: true, ...f,
      spoken_summary: `This order already has quote ${f.quote_number}${prior.status === "accepted" ? ", and it has been accepted" : `, valid until ${f.valid_until}`}. I haven't created a second one.` };
  }
  if (same.some((q) => q.status === "accepted"))
    return { ok: true, promo_applied: false, spoken_summary: `This order was already accepted, so I can't add a promo code to it now. A specialist can review it with you.` };
  for (const q of same) if (q.status === "open" || q.status === "draft") await stripe.quotes.cancel(q.id);

  const line_items: Stripe.QuoteCreateParams.LineItem[] = [];
  for (const l of lines) {
    line_items.push({
      quantity: l.qty,
      price_data: {
        currency: "usd", product: await productFor(stripe, l.product), unit_amount: cents(l.unit_net),
        ...(taxOn ? { tax_behavior: "exclusive" as const } : {}),
        ...(l.billing === "monthly" ? { recurring: { interval: "month" as const } } : {}),
      },
    });
  }
  const discounts = lines.filter((l) => l.volume_discount_pct || l.extra_discount_pct).map(describe).join("; ");

  const params: Stripe.QuoteCreateParams = {
    customer: customer.id, line_items,
    collection_method: "send_invoice", invoice_settings: { days_until_due: 30 },
    header: "Summit Office Supply order quote",
    description: `Quoted by phone via Quinn. Net prices${discounts ? ` include: ${discounts}` : ""}.${promo?.valid ? ` Promo ${promo.code}: ${promo.terms}.` : ""}${taxOn ? " Sales tax calculated by Stripe Tax." : " Prices exclude tax."}`.slice(0, 500),
    ...(taxOn ? { automatic_tax: { enabled: true } } : {}),
    footer: `Pricing reference ${quoteId}`,
    metadata: { quote_id: quoteId, source: "quinn_voice_agent", promo_code: promo?.valid ? promo.code : "" },
    subscription_data: { metadata: { quote_id: quoteId, source: "quinn_voice_agent", term_months: "12", promo_code: promo?.valid ? promo.code : "" } },
  };
  let draft: Stripe.Quote;
  if (promo?.valid) {
    // Prefer the promotion code itself (Stripe tracks redemptions); fall back to its coupon on API versions
    // where quotes don't accept promotion_code. resolvePromo already enforced the code's rules either way.
    try {
      draft = await stripe.quotes.create({ ...params, discounts: [{ promotion_code: promo.promotion_code_id } as any] }, key("stripe-quote"));
    } catch (e) {
      if (!/promotion_code/i.test(String((e as Error).message))) throw e;
      draft = await stripe.quotes.create({ ...params, discounts: [{ coupon: promo.coupon_id }] }, key("stripe-quote-coupon"));
    }
  } else {
    draft = await stripe.quotes.create(params, key("stripe-quote"));
  }
  const q = await stripe.quotes.finalizeQuote(draft.id, {}, key("stripe-quote-finalize"));
  const f = quoteFacts(q);
  const li = await stripe.quotes.listLineItems(q.id, { limit: 20 });
  const quote_lines = li.data.map((x) => ({ description: x.description, quantity: x.quantity, total: x.amount_total / 100, billing: x.price?.type === "recurring" ? "monthly" : "one_time" }));

  const parts: string[] = [];
  const oneTime = f.tax_enabled ? f.one_time_before_tax : f.one_time_total, monthlyAmt = f.tax_enabled ? f.monthly_before_tax : f.monthly_total;
  if (oneTime) parts.push(`${money(cents(oneTime))} one-time`);
  if (monthlyAmt) parts.push(`${money(cents(monthlyAmt))} a month`);
  let spoken = `Quote ${f.quote_number} is ready: ${parts.join(" plus ")}${f.tax_enabled ? " before tax" : ""}.`;
  // Stripe Tax: speak Stripe's own tax amounts and totals.
  const taxLine = !f.tax_enabled ? ""
    : f.tax_first_invoice
      ? ` Sales tax is ${money(cents(f.tax_first_invoice))} on the first invoice, for a first-invoice total of ${money(cents(f.first_invoice_total))}`
        + (f.monthly_total ? `, then ${money(cents(f.monthly_total))} a month including ${money(cents(f.tax_monthly))} tax.` : ".")
      : ` Stripe Tax calculated no sales tax for that ship-to ZIP code.`;
  spoken += taxLine;
  let discounted_monthly: number | null = null;
  if (promo?.valid) {
    // With a promo, Stripe spreads the discount over the whole first invoice, so speak that invoice's total
    // rather than splitting it, then say what later monthly invoices cost while the promo still applies.
    const c = promo.coupon;
    const firstInv = money(cents(f.first_invoice_total));
    const saved = f.first_invoice_discount ? `, saving ${money(cents(f.first_invoice_discount))}` : "";
    const full = money(cents(f.tax_enabled ? f.monthly_before_tax : f.monthly_total)) + (f.tax_enabled ? " before tax" : "");
    spoken = f.monthly_total
      ? `Quote ${f.quote_number} is ready. With promo code ${promo.code}, your first invoice, which covers the one-time items and your first month, is ${firstInv}${saved}.`
      : `Quote ${f.quote_number} is ready: ${firstInv} with promo code ${promo.code}${saved}.`;
    if (f.tax_enabled) spoken += f.tax_first_invoice ? ` That total includes ${money(cents(f.tax_first_invoice))} sales tax.` : ` Stripe Tax calculated no sales tax for that ship-to ZIP code.`;
    if (f.monthly_total) {
      const m = cents(f.tax_enabled ? f.monthly_before_tax : f.monthly_total);
      const off = c.duration === "once" ? 0 : c.percent_off ? Math.round(m * c.percent_off / 100) : Math.min(m, c.amount_off ?? 0);
      if (off) discounted_monthly = (m - off) / 100;
      spoken += !off ? ` After that it's ${full} a month.`
        : c.duration === "repeating" && (c.duration_in_months ?? 0) > 1
          ? ` After that, your monthly invoices are ${money(m - off)}${f.tax_enabled ? " before tax" : ""} through month ${c.duration_in_months}, then ${full} a month.`
          : c.duration === "repeating" ? ` After that it's ${full} a month.`
          : ` After that it's ${money(m - off)} a month with the promo${f.tax_enabled ? ", before tax" : ""}.`;
    }
  }
  return { ok: true, ...f, promo_applied: !!promo?.valid, discounted_monthly, quote_lines,
    spoken_summary: `${spoken} It's valid until ${f.valid_until}. Would you like to accept it now, or take some time to review it?` };
}

async function findQuoteByNumber(stripe: Stripe, spoken: string): Promise<Stripe.Quote | null> {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const want = norm(spoken);
  if (!want) return null;
  let starting_after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await stripe.quotes.list({ limit: 100, starting_after });
    // Exact match first; otherwise allow the caller to omit the trailing revision ("-1").
    const hit = list.data.find((q) => q.number && norm(q.number) === want)
      ?? list.data.find((q) => q.number && norm(q.number).startsWith(want) && norm(q.number).length - want.length <= 2);
    if (hit) return hit;
    if (!list.has_more) break;
    starting_after = list.data[list.data.length - 1]?.id;
  }
  return null;
}

async function acceptStripeQuote(body: any) {
  const stripe = getStripe();
  const ref = String(body?.quote_number ?? "").trim();
  if (!ref) throw new Error("quote_number is required");

  let q = ref.startsWith("qt_") ? await stripe.quotes.retrieve(ref) : await findQuoteByNumber(stripe, ref);
  if (!q) return { ok: true, found: false, spoken_summary: `I couldn't find quote ${ref}. Could you read me the quote number again?` };
  if (q.status === "canceled") return { ok: true, found: true, status: q.status, spoken_summary: `Quote ${q.number} was canceled, so it can't be accepted. I can put together a fresh quote for you.` };
  if (q.status === "draft") q = await stripe.quotes.finalizeQuote(q.id);
  if (q.status === "open") {
    if (q.expires_at && q.expires_at * 1000 < Date.now())
      return { ok: true, found: true, status: "expired", spoken_summary: `Quote ${q.number} expired on ${asDate(q.expires_at)}. I can re-quote the order at today's prices.` };
    q = await stripe.quotes.accept(q.id, {}, { idempotencyKey: `quinn:accept:${q.id}` });
  }

  // Stripe generated the billing objects on acceptance; read them back.
  let subscription: Stripe.Subscription | null = null;
  let invoice: Stripe.Invoice | null = null;
  if (q.subscription) {
    subscription = await stripe.subscriptions.retrieve(String(q.subscription));
    if (subscription.latest_invoice) invoice = await stripe.invoices.retrieve(String(subscription.latest_invoice));
  } else if (q.invoice) {
    invoice = await stripe.invoices.retrieve(String(q.invoice));
  }
  if (invoice?.status === "draft") invoice = await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `quinn:accept-finalize:${invoice.id}` });

  const f = quoteFacts(q);
  let spoken = `Quote ${q.number} is accepted.`;
  if (invoice) spoken += ` Invoice ${invoice.number} for ${money(invoice.total)} is on its way with a pay-online link`
    + (subscription && f.monthly_total ? `, and it includes your first month.` : `.`);
  if (subscription && f.monthly_total) spoken += ` Your subscription of ${money(cents(f.monthly_total))} a month is active.`;
  return { ok: true, found: true, ...f,
    invoice_number: invoice?.number ?? null, hosted_invoice_url: invoice?.hosted_invoice_url ?? null,
    subscription_id: subscription?.id ?? null, spoken_summary: spoken };
}

/* ------------------------------------------- Quinn: mid-term subscription changes (preview -> confirm) */
//
// "Add 5 more printers to my toner plan." Two steps so the caller hears the money before anything changes:
//   POST /subscription/preview  -> Stripe-computed proration for the change; writes nothing
//   POST /subscription/change   -> applies it (proration_behavior: always_invoice) and returns the proration invoice
// The preview returns a proration_date that the change call passes back, so the charge matches what was quoted.

async function findSubscriptionItem(stripe: Stripe, body: any) {
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) return { error: `I couldn't find an account for that dealer. Can you give me the dealer number?` };
  const subs = await stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 20 });
  const want = String(body?.product ?? "").toLowerCase().trim();
  const matches: { sub: Stripe.Subscription; item: Stripe.SubscriptionItem; name: string }[] = [];
  for (const s of subs.data) for (const it of s.items.data) {
    if (body?.subscription_id && s.id !== body.subscription_id) continue;
    const pid = typeof it.price.product === "string" ? it.price.product : it.price.product.id;
    const name = ((await stripe.products.retrieve(pid)).name ?? "subscription").split(" — ")[0]; // speakable name
    if (!want || name.toLowerCase().includes(want) || want.split(/\s+/).some((w) => w.length > 3 && name.toLowerCase().includes(w))) matches.push({ sub: s, item: it, name });
  }
  if (!matches.length) return { error: `I don't see an active ${want || "subscription"} on ${customer.name ?? "that account"}.` };
  if (matches.length > 1) return { error: `${customer.name ?? "That account"} has more than one matching subscription, so I'll have a specialist make this change to be safe.` };
  return { customer, ...matches[0] };
}

function targetQuantity(body: any, current: number): number | null {
  if (body?.new_quantity != null && body.new_quantity !== "") return Math.round(Number(body.new_quantity));
  if (body?.change_by != null && body.change_by !== "") return current + Math.round(Number(body.change_by));
  return null;
}

async function previewSubscriptionChange(body: any) {
  const stripe = getStripe();
  const f = await findSubscriptionItem(stripe, body);
  if ("error" in f) return { ok: true, found: false, spoken_summary: f.error };
  const { customer, sub, item, name } = f;
  const current = item.quantity ?? 1;
  const next = targetQuantity(body, current);
  if (next == null || !Number.isFinite(next)) throw new Error("Provide new_quantity or change_by");
  if (next < 1) return { ok: true, found: true, spoken_summary: `I can't cancel a subscription by phone. A specialist will follow up about ending the ${name}.` };
  if (next === current) return { ok: true, found: true, spoken_summary: `Your ${name} is already at ${current}. Nothing to change.` };

  const proration_date = Math.floor(Date.now() / 1000);
  // Create Preview Invoice works for both classic and flexible billing-mode subscriptions.
  const preview: any = await (stripe.invoices as any).createPreview({
    customer: customer.id, subscription: sub.id,
    subscription_details: { items: [{ id: item.id, quantity: next }], proration_behavior: "always_invoice", proration_date },
  });
  const isProration = (l: any) => l.proration ?? l.parent?.subscription_item_details?.proration ?? l.parent?.invoice_item_details?.proration ?? false;
  const proration = preview.lines.data.filter(isProration).reduce((a: number, l: any) => a + l.amount, 0);
  const unit = item.price.unit_amount ?? 0;
  const before = unit * current, after = unit * next;
  const periodEnd = asDate((sub as any).current_period_end);

  let spoken = `Changing your ${name} from ${current} to ${next} takes it from ${money(before)} to ${money(after)} a month.`;
  spoken += proration > 0
    ? ` For the rest of this billing period, through ${periodEnd}, there's a prorated charge of ${money(proration)} on a separate invoice today.`
    : proration < 0 ? ` You'll get a prorated credit of ${money(-proration)} for the rest of this billing period.` : "";
  spoken += ` Would you like me to make that change?`;
  return { ok: true, found: true, subscription_id: sub.id, product: name, current_quantity: current, new_quantity: next,
    monthly_before: before / 100, monthly_after: after / 100, prorated_amount: proration / 100, proration_date, spoken_summary: spoken };
}

async function applySubscriptionChange(body: any) {
  const stripe = getStripe();
  const f = await findSubscriptionItem(stripe, body);
  if ("error" in f) return { ok: true, found: false, spoken_summary: f.error };
  const { sub, item, name } = f;
  const current = item.quantity ?? 1;
  // Absolute quantity only: a retried "add 5" must not add 5 twice.
  const next = body?.new_quantity != null && body.new_quantity !== "" ? Math.round(Number(body.new_quantity)) : null;
  if (next == null || !Number.isFinite(next)) throw new Error("Pass new_quantity exactly as returned by the preview");
  if (next < 1) return { ok: true, found: true, spoken_summary: `I can't cancel a subscription by phone. A specialist will follow up about ending the ${name}.` };
  if (next === current) return { ok: true, found: true, already_applied: true, spoken_summary: `Your ${name} is set at ${current}, ${money((item.price.unit_amount ?? 0) * current)} a month. No further change needed.` };

  // Honor the previewed proration_date if it's recent, so the charge matches what the caller agreed to.
  const pd = Number(body?.proration_date);
  const proration_date = Number.isFinite(pd) && Date.now() / 1000 - pd < 3600 ? pd : Math.floor(Date.now() / 1000);

  const updated = await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, quantity: next }],
    proration_behavior: "always_invoice", proration_date,
    metadata: { ...sub.metadata, last_change: `quantity ${current}->${next} via quinn_voice_agent` },
  }, { idempotencyKey: `quinn:change:${sub.id}:${item.id}:${current}->${next}` });

  let invoice: Stripe.Invoice | null = updated.latest_invoice ? await stripe.invoices.retrieve(String(updated.latest_invoice)) : null;
  if (invoice && invoice.billing_reason !== "subscription_update") invoice = null; // not a proration invoice
  if (invoice?.status === "draft") invoice = await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `quinn:change-finalize:${invoice.id}` });

  const after = (item.price.unit_amount ?? 0) * next;
  let spoken = `Done. Your ${name} is now ${next}, at ${money(after)} a month.`;
  if (invoice && invoice.total > 0) spoken += ` Invoice ${invoice.number} for ${money(invoice.total)} covers the prorated difference and has a pay-online link.`;
  else if (invoice && invoice.total < 0) spoken += ` A prorated credit of ${money(-invoice.total)} goes toward your next invoice.`;
  return { ok: true, found: true, subscription_id: updated.id, product: name, new_quantity: next, monthly_after: after / 100,
    proration_invoice_number: invoice?.number ?? null, proration_invoice_total: invoice ? invoice.total / 100 : null,
    hosted_invoice_url: invoice?.hosted_invoice_url ?? null, spoken_summary: spoken };
}

/* ------------------------------------------------------------- Riley: subscriptions (read-only) */

async function lookupSubscriptions(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? body);
  if (!customer) return { ok: true, found: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number or the email on the account?` };

  const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 20 });
  const live = subs.data.filter((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
  const names = new Map<string, string>();
  const productName = async (p: string | Stripe.Product | Stripe.DeletedProduct) => {
    const id = typeof p === "string" ? p : p.id;
    if (!names.has(id)) names.set(id, (await stripe.products.retrieve(id)).name);
    return names.get(id)!;
  };

  const out = [];
  for (const s of live) {
    const items = [];
    for (const it of s.items.data) {
      const metered = it.price.recurring?.usage_type === "metered";
      const unit = metered ? 0 : it.price.unit_amount ?? 0, qty = metered ? 0 : it.quantity ?? 1;
      items.push({ product: await productName(it.price.product), quantity: qty, unit_amount: unit / 100, line_total: (unit * qty) / 100, interval: it.price.recurring?.interval ?? "month", metered });
    }
    out.push({
      id: s.id, status: s.status, items,
      recurring_total: items.reduce((a, i) => a + i.line_total, 0),
      started: asDate(s.start_date),
      next_invoice_date: asDate((s as any).current_period_end ?? (s.items.data[0] as any)?.current_period_end),
      cancel_at_period_end: s.cancel_at_period_end, term_months: s.metadata?.term_months ?? null,
    });
  }

  const name = customer.name || "That account";
  let spoken: string;
  if (!out.length) spoken = `${name} has no active subscriptions.`;
  else {
    spoken = `${name} has ${out.length} active subscription${out.length === 1 ? "" : "s"}.`;
    for (const s of out.slice(0, 3)) {
      const what = s.items.map((i) => i.metered
        ? `${i.product}, billed by usage per your print plan`
        : `${i.product}, ${i.quantity} at ${money(cents(i.unit_amount))} each`).join("; ");
      const usage = s.items.some((i) => i.metered);
      spoken += ` ${what}, for ${money(cents(s.recurring_total))} a month${usage ? " plus usage" : ""}`;
      spoken += s.cancel_at_period_end ? `. It's set to end on ${s.next_invoice_date}.` : `. The next invoice is on ${s.next_invoice_date}.`;
      if (s.status === "past_due" || s.status === "unpaid") spoken += ` This subscription has a past-due balance.`;
    }
  }
  return { ok: true, found: true, customer_id: customer.id, subscriptions: out, spoken_summary: spoken };
}

/* ------------------------------------------------------------- Riley: billing status (read-only) */

function invoiceStatusLine(inv: Stripe.Invoice): string {
  const num = inv.number || inv.id;
  const total = money(inv.total);
  if (inv.status === "paid") return `Invoice ${num} for ${total} is paid in full. Nothing is outstanding.`;
  if (inv.status === "open") {
    const due = asDate(inv.due_date);
    return `Invoice ${num} for ${total} is still open. The balance of ${money(inv.amount_remaining)} is due${due ? " by " + due : ""}.`;
  }
  if (inv.status === "draft") return `Invoice ${num} is still a draft and has not been sent yet.`;
  if (inv.status === "void") return `Invoice ${num} was voided and is no longer owed.`;
  if (inv.status === "uncollectible") return `Invoice ${num} for ${total} is marked uncollectible. Please escalate to accounts receivable.`;
  return `Invoice ${num} has status ${inv.status}.`;
}

const summarizeInvoice = (inv: Stripe.Invoice) => ({
  number: inv.number, status: inv.status, total: inv.total / 100,
  amount_due: inv.amount_due / 100, amount_paid: inv.amount_paid / 100, amount_remaining: inv.amount_remaining / 100,
  currency: inv.currency, due_date: asDate(inv.due_date), paid_at: asDate(inv.status_transitions?.paid_at),
  hosted_invoice_url: inv.hosted_invoice_url,
});



async function lookupStatus(body: any) {
  const stripe = getStripe();

  if (body?.invoice_number) {
    const inv = await findInvoiceByNumber(stripe, String(body.invoice_number).trim());
    if (!inv) return { ok: true, found: false, spoken_summary: `I couldn't find an invoice numbered ${body.invoice_number}. Could you double-check the number?` };
    const usage = await explainUsageInvoice(stripe, inv);
    const failure = await paymentFailureLine(stripe, inv);
    return { ok: true, found: true, invoice: summarizeInvoice(inv), payment_failed: !!failure, spoken_summary: invoiceStatusLine(inv) + usage + failure };
  }

  if (body?.dealer) {
    const customer = await findCustomer(stripe, body.dealer);
    if (!customer) return { ok: true, found: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number or the email on the account?` };
    const list = await stripe.invoices.list({ customer: customer.id, limit: 100 });
    const open = list.data.filter((i) => i.status === "open");
    const openTotal = open.reduce((s, i) => s + i.amount_remaining, 0);
    open.sort((a, b) => (a.due_date || 0) - (b.due_date || 0));
    const name = customer.name || "That account";
    let spoken: string;
    if (open.length === 0) spoken = `${name} has no open invoices — you're all paid up.`;
    else {
      const o = open[0]; const due = asDate(o.due_date);
      spoken = `${name} has ${open.length} open invoice${open.length === 1 ? "" : "s"} totaling ${money(openTotal)}. The oldest, ${o.number}, is for ${money(o.total)}${due ? " and is due " + due : ""}.`;
    }
    const failed = open.find((i) => i.collection_method === "charge_automatically" && i.attempt_count > 0);
    if (failed) spoken += await paymentFailureLine(stripe, failed);
    return { ok: true, found: true, customer_id: customer.id, open_count: open.length, open_total: openTotal / 100, open_invoices: open.map(summarizeInvoice), payment_failed: !!failed, spoken_summary: spoken };
  }

  throw new Error("Provide invoice_number or dealer");
}

/* ------------------------------------------------- Riley: credit notes (preview -> confirm -> issue) */
//
// "Two of the toner cartridges arrived cracked." Riley can credit an invoice by phone, within policy:
//   - at most $100 of phone credits per invoice (anything more goes to a specialist)
//   - open invoice: the credit lowers the balance due; paid invoice: it becomes account credit for the next bill
//   - never a refund to a card, never on draft/void/uncollectible invoices
//   POST /credit/preview -> Stripe credit note preview; writes nothing
//   POST /credit/issue   -> creates the credit note (idempotent), after the caller says yes

const PHONE_CREDIT_LIMIT = 10000; // cents per invoice
const CREDIT_REASONS: Record<string, { stripe: Stripe.CreditNoteCreateParams.Reason; spoken: string }> = {
  damaged: { stripe: "product_unsatisfactory", spoken: "damaged items" },
  defective: { stripe: "product_unsatisfactory", spoken: "defective items" },
  not_satisfied: { stripe: "product_unsatisfactory", spoken: "an unsatisfactory product" },
  wrong_item: { stripe: "order_change", spoken: "the wrong item shipped" },
  short_shipped: { stripe: "order_change", spoken: "a short shipment" },
  pricing_error: { stripe: "order_change", spoken: "a pricing error" },
  duplicate_charge: { stripe: "duplicate", spoken: "a duplicate charge" },
};

async function creditContext(stripe: Stripe, body: any) {
  const number = String(body?.invoice_number ?? "").trim();
  if (!number) return { stop: `Which invoice is this about? Please read me the invoice number.` };
  const inv = await findInvoiceByNumber(stripe, number);
  if (!inv) return { stop: `I couldn't find invoice ${number}. Could you read me the number again?` };
  if (inv.status !== "open" && inv.status !== "paid")
    return { stop: `Invoice ${inv.number} is ${inv.status}, so I can't credit it by phone. A specialist will follow up.`, specialist: true };

  const cat = String(body?.reason ?? "").toLowerCase().trim();
  const reason = CREDIT_REASONS[cat];
  if (!reason) return { stop: `What was the issue: damaged or defective items, the wrong item, a short shipment, a pricing error, or a duplicate charge?` };
  const amount = cents(body?.amount);
  if (!(amount > 0)) return { stop: `How much should the credit be?` };

  // Credits Riley already issued on this invoice. A repeat of the same request is reported, not re-issued.
  const prior = await stripe.creditNotes.list({ invoice: inv.id, limit: 100 });
  const phone = prior.data.filter((c) => c.metadata?.source === "riley_voice_agent" && c.status !== "void");
  const request_key = `${amount}:${cat}`;
  const same = phone.find((c) => c.metadata?.request_key === request_key);
  const already = phone.reduce((s, c) => s + c.amount, 0);

  const ceiling = inv.status === "open" ? inv.amount_remaining : inv.amount_paid - (inv.post_payment_credit_notes_amount ?? 0);
  return { inv, cat, reason, amount, request_key, same, already, ceiling };
}

function creditParams(c: any): Stripe.CreditNoteCreateParams {
  const note = String(c.body?.note ?? "").slice(0, 200);
  return {
    invoice: c.inv.id, amount: c.amount, reason: c.reason.stripe,
    ...(c.inv.status === "paid" ? { credit_amount: c.amount } : {}),
    memo: `Phone credit for ${c.reason.spoken}${note ? `: ${note}` : ""}`.slice(0, 500),
    metadata: { source: "riley_voice_agent", reason_category: c.cat, request_key: c.request_key, note },
  };
}

function creditPolicyStop(c: any): { spoken: string; specialist: boolean } | null {
  if (c.amount > c.ceiling)
    return { spoken: `That's more than the ${money(c.ceiling)} ${c.inv.status === "open" ? "still due" : "paid"} on invoice ${c.inv.number}, so I can't credit that amount. A specialist will follow up.`, specialist: true };
  if (c.already + c.amount > PHONE_CREDIT_LIMIT)
    return { spoken: `I can credit up to ${money(PHONE_CREDIT_LIMIT)} per invoice by phone${c.already ? `, and ${money(c.already)} has already been credited on this one` : ""}. A billing specialist will follow up to review a credit of ${money(c.amount)}.`, specialist: true };
  return null;
}

async function previewCredit(body: any) {
  const stripe = getStripe();
  const c: any = await creditContext(stripe, body);
  if (c.stop) return { ok: true, can_credit: false, needs_specialist: !!c.specialist, spoken_summary: c.stop };
  c.body = body;
  if (c.same) return { ok: true, can_credit: false, already_issued: true, credit_note_number: c.same.number,
    spoken_summary: `I already issued credit note ${c.same.number} for ${money(c.same.amount)} on invoice ${c.inv.number} for this. Nothing more is needed.` };
  const stop = creditPolicyStop(c);
  if (stop) return { ok: true, can_credit: false, needs_specialist: stop.specialist, spoken_summary: stop.spoken };

  const preview = await stripe.creditNotes.preview(creditParams(c) as any);
  const after = c.inv.status === "open" ? c.inv.amount_remaining - preview.amount : null;
  const effect = c.inv.status === "open"
    ? `That lowers the balance due on invoice ${c.inv.number} from ${money(c.inv.amount_remaining)} to ${money(after!)}.`
    : `Invoice ${c.inv.number} is already paid, so the ${money(preview.amount)} goes on your account as a credit toward your next invoice.`;
  return { ok: true, can_credit: true, invoice_number: c.inv.number, amount: preview.amount / 100, reason: c.cat,
    balance_after: after == null ? null : after / 100,
    spoken_summary: `I can issue a credit of ${money(preview.amount)} on invoice ${c.inv.number} for ${c.reason.spoken}. ${effect} Would you like me to issue it?` };
}

async function issueCredit(body: any) {
  const stripe = getStripe();
  const c: any = await creditContext(stripe, body);
  if (c.stop) return { ok: true, issued: false, needs_specialist: !!c.specialist, spoken_summary: c.stop };
  c.body = body;
  if (c.same) return { ok: true, issued: true, already_issued: true, credit_note_number: c.same.number,
    spoken_summary: `Credit note ${c.same.number} for ${money(c.same.amount)} is already on invoice ${c.inv.number}. Nothing more is needed.` };
  const stop = creditPolicyStop(c);
  if (stop) return { ok: true, issued: false, needs_specialist: stop.specialist, spoken_summary: stop.spoken };

  const cn = await stripe.creditNotes.create(creditParams(c), { idempotencyKey: `riley:credit:${c.inv.id}:${c.request_key}` });
  const inv = await stripe.invoices.retrieve(c.inv.id);
  const effect = inv.status === "paid" && c.inv.status === "paid"
    ? `It's on your account as a credit toward your next invoice.`
    : inv.status === "paid" ? `That covers the rest of invoice ${inv.number}, so nothing more is due on it.`
    : `The balance due on invoice ${inv.number} is now ${money(inv.amount_remaining)}.`;
  return { ok: true, issued: true, credit_note_number: cn.number, amount: cn.amount / 100, invoice_number: inv.number,
    invoice_balance: inv.amount_remaining / 100, credit_note_pdf: cn.pdf,
    spoken_summary: `Done. Credit note ${cn.number} for ${money(cn.amount)} is issued on invoice ${inv.number}. ${effect}` };
}

/* ------------------------------------------------------------------------------ router */

export default async function (req: Request): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
  const url = new URL(req.url);
  ORIGIN = `https://${url.host}`;
  const path = url.pathname.replace(/\/+$/, "");
  const key = Deno.env.get("STRIPE_SECRET_KEY");

  // GET /quote-pdf/qt_...  -> the Stripe-rendered quote PDF (ids are unguessable; test mode only)
  const pdf = path.match(/\/quote-pdf\/(qt_[A-Za-z0-9]+)$/);
  if (req.method === "GET" && pdf && key) {
    const r = await fetch(`https://files.stripe.com/v1/quotes/${pdf[1]}/pdf`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return json({ error: `Quote PDF not available (${r.status})` }, 404);
    return new Response(r.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf[1]}.pdf"` } });
  }

  if (req.method === "GET" && path.endsWith("/followups")) return await followupsPage();
  if (req.method === "GET" && path.endsWith("/dashboard") && key) return await dashboardPage();
  if (req.method === "POST" && path.endsWith("/stripe/webhook") && key) return await handleStripeWebhook(req);

  if (req.method !== "POST")
    return json({ service: "Summit Office Supply Stripe endpoints", routes: {
      "POST /": "Quinn: create invoice directly",
      "POST /quote": "Quinn: create a finalized Stripe Quote",
      "POST /quote/accept": "Quinn: accept a Stripe Quote (Stripe generates invoice/subscription)",
      "GET /quote-pdf/:id": "Quote PDF",
      "POST /status": "Riley: invoice status (read-only)",
      "POST /subscriptions": "Riley: subscription details (read-only)",
      "POST /subscription/preview": "Quinn: preview a quantity change with Stripe proration (no writes)",
      "POST /subscription/change": "Quinn: apply a quantity change (prorated invoice)",
      "POST /promo/check": "Quinn: validate a promotion code (read-only)",
      "POST /credit/preview": "Riley: preview a credit note within phone policy (no writes)",
      "POST /credit/issue": "Riley: issue the credit note after the caller confirms",
      "POST /usage": "Riley: managed print usage this period and next-invoice estimate (read-only)",
      "POST /usage/report": "Printer feed: record pages printed as a Stripe meter event",
      "POST /usage/setup": "Admin: ensure the managed print meter/prices and enroll a dealer",
      "POST /usage/plan-options": "Quinn: compare this period on the 5K and 25K print plans (read-only)",
      "POST /usage/plan-change": "Quinn: switch print plans at the next billing period",
      "POST /demo/clock": "Admin: test-clock demo dealer (setup / advance / status)",
      "POST /demo/dunning": "Admin: card-billed test-clock dealer for failed-payment recovery",
      "POST /followup": "Quinn and Riley: log a tracked specialist follow-up",
      "GET /followups": "Open follow-up queue (HTML)",
      "GET /dashboard": "Live revenue dashboard (HTML)",
      "POST /credits/buy": "Quinn: sell prepaid print credit (confirmed: true to invoice)",
      "POST /credits": "Riley: prepaid print credit balance (read-only)",
      "POST /payment/link": "Riley: have Stripe email the invoice's secure payment page",
      "POST /payment/retry": "Riley: have Stripe retry a failed card payment now (confirmed: true)",
      "POST /stripe/webhook": "Stripe events: invoice.paid, invoice.payment_failed",
      "POST /demo/stripe-setup": "Admin: Stripe Tax settings + registration, webhook endpoint",
      "POST /demo/pay-invoice": "Admin: mark an emailed invoice paid by check (test mode)",
    } });
  if (!key) return json({ error: "STRIPE_SECRET_KEY is not set" }, 500);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  try {
    const result =
      path.endsWith("/quote/accept") ? await acceptStripeQuote(body)
      : path.endsWith("/quote") ? await createStripeQuote(body)
      : path.endsWith("/subscription/preview") ? await previewSubscriptionChange(body)
      : path.endsWith("/subscription/change") ? await applySubscriptionChange(body)
      : path.endsWith("/subscriptions") ? await lookupSubscriptions(body)
      : path.endsWith("/promo/check") ? await checkPromo(body)
      : path.endsWith("/credit/preview") ? await previewCredit(body)
      : path.endsWith("/credit/issue") ? await issueCredit(body)
      : path.endsWith("/usage/setup") ? await setupPrintPlan(body)
      : path.endsWith("/usage/plan-options") ? await printPlanOptions(body)
      : path.endsWith("/usage/plan-change") ? await changePrintPlan(body)
      : path.endsWith("/demo/clock") ? await demoClock(body)
      : path.endsWith("/demo/dunning") ? await demoDunning(body)
      : path.endsWith("/demo/stripe-setup") ? await stripeSetup(ORIGIN)
      : path.endsWith("/demo/pay-invoice") ? await demoPayInvoice(body)
      : path.endsWith("/credits/buy") ? await buyPrintCredits(body)
      : path.endsWith("/credits") ? await lookupPrintCredits(body)
      : path.endsWith("/payment/link") ? await sendPaymentLink(body)
      : path.endsWith("/payment/retry") ? await retryPayment(body)
      : path.endsWith("/followup") ? await logFollowUp({ ...body, agent: body?.agent ?? url.searchParams.get("agent") ?? "" }, async (d) => {
        const c = await findCustomer(getStripe(), d);
        return c ? { id: c.metadata?.dealer_id, name: c.name ?? undefined } : null;
      })
      : path.endsWith("/usage/report") ? await reportPrintUsage(body)
      : path.endsWith("/usage") ? await lookupPrintUsage(body)
      : path.endsWith("/status") ? await lookupStatus(body)
      : await createInvoice(body);
    return json(result);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 400);
  }
}
