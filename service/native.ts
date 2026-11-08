// Summit Office Supply: Stripe-native plumbing for the Quinn and Riley voice agents.
//   Stripe webhooks        POST /stripe/webhook   invoice.paid / invoice.payment_failed drive follow-ups, credits, the dashboard
//   Prepaid print credits  POST /credits/buy (Quinn), POST /credits (Riley)   Stripe Billing credit grants
//   One-time setup         POST /demo/stripe-setup   Stripe Tax settings + registration, webhook endpoint (test mode)
import { Stripe, asDate, findCustomer, getStripe, money, priceIdOf } from "./core.ts";
import { hasOpenFollowUp, invoicesWithActivity, logActivity, logFollowUp, resolveFollowUps } from "./followups.ts";
import { printPlanOf } from "./print.ts";

// Billing credits (credit grants) arrived in API version 2024-10-28.acacia; the rest of the service stays on 2024-06-20.
const CREDITS_API = { apiVersion: "2024-10-28.acacia" } as any;
const WEBHOOK_EVENTS = ["invoice.paid", "invoice.payment_failed"];

/* --------------------------------------------------------------------------------- one-time setup */

// POST /demo/stripe-setup  (admin, test mode). Idempotent: safe to run again.
export async function stripeSetup(origin: string) {
  const stripe = getStripe();
  const out: any = {};
  // Stripe Tax: Summit ships from Austin, Texas; prices are quoted before tax; products default to general tangible goods.
  const settings = await stripe.tax.settings.update({
    head_office: { address: { line1: "1 Summit Way", city: "Austin", state: "TX", postal_code: "78701", country: "US" } },
    defaults: { tax_behavior: "exclusive", tax_code: "txcd_99999999" },
  });
  out.tax_status = settings.status;
  const regs = await stripe.tax.registrations.list({ status: "all", limit: 100 });
  const tx = regs.data.find((r: any) => r.country === "US" && r.country_options?.us?.state === "TX" && r.status !== "expired");
  out.tax_registration = tx?.id ?? (await stripe.tax.registrations.create({
    country: "US", active_from: "now", country_options: { us: { state: "TX", type: "state_sales_tax" } },
  } as any)).id;

  // Webhook endpoint for this service. Events are verified by re-fetching them from Stripe (or by signature, if
  // STRIPE_WEBHOOK_SECRET is set), so the signing secret is never returned or stored here.
  const url = `${origin}/stripe/webhook`;
  const eps = await stripe.webhookEndpoints.list({ limit: 100 });
  let ep = eps.data.find((e) => e.url === url);
  if (!ep) ep = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS as any, description: "Quinn & Riley: payment recovery, prepaid credits, dashboard" });
  else if (WEBHOOK_EVENTS.some((t) => !ep!.enabled_events.includes(t))) ep = await stripe.webhookEndpoints.update(ep.id, { enabled_events: WEBHOOK_EVENTS as any });
  out.webhook = { id: ep.id, url: ep.url, status: ep.status, events: ep.enabled_events };

  // Stripe customer portal: dealers update their card and see invoices themselves; the login page emails a sign-in link.
  const confs = await stripe.billingPortal.configurations.list({ active: true, limit: 20 });
  const portal = confs.data.find((c) => c.metadata?.summit === "1") ?? await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Summit Office Supply: manage your billing" },
    features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, customer_update: { enabled: true, allowed_updates: ["email", "address"] } },
    login_page: { enabled: true }, metadata: { summit: "1" },
  });
  out.portal = { id: portal.id, login_url: portal.login_page?.url ?? null };

  // Card-billed demo dealer: a card used on Stripe's hosted invoice page becomes the card for future renewals.
  const eastgate = await findCustomer(stripe, { id: "D-3002" });
  if (eastgate) {
    const subs = await stripe.subscriptions.list({ customer: eastgate.id, status: "all", limit: 10 });
    for (const s of subs.data.filter((s) => s.status !== "canceled"))
      await stripe.subscriptions.update(s.id, { payment_settings: { save_default_payment_method: "on_subscription" } });
    out.eastgate_save_card = subs.data.length;
  }
  return { ok: true, ...out };
}

// POST /demo/pay-invoice { invoice_number }  (admin, test mode): record a send_invoice invoice as paid by check,
// which fires invoice.paid exactly as a real payment would. Card-billed invoices go through /payment/retry instead.
export async function demoPayInvoice(body: any) {
  const stripe = getStripe();
  const r = await stripe.invoices.search({ query: `number:"${String(body?.invoice_number ?? "").replace(/"/g, "")}"`, limit: 1 });
  const inv = r.data[0];
  if (!inv) throw new Error("Invoice not found");
  if (inv.collection_method !== "send_invoice") throw new Error("Only invoices billed by email can be marked paid here");
  const paid = inv.status === "paid" ? inv : await stripe.invoices.pay(inv.id, { paid_out_of_band: true });
  return { ok: true, invoice_number: paid.number, status: paid.status, amount_paid: paid.amount_paid / 100 };
}

export async function taxActive(stripe: Stripe): Promise<boolean> {
  try { return (await stripe.tax.settings.retrieve()).status === "active"; } catch (_e) { return false; }
}

/* ------------------------------------------------------------------------------- Stripe webhook */

export async function handleStripeWebhook(req: Request): Promise<Response> {
  const stripe = getStripe();
  const raw = await req.text();
  const ok = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  let evt: Stripe.Event;
  try {
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (secret) evt = await stripe.webhooks.constructEventAsync(raw, req.headers.get("stripe-signature") ?? "", secret);
    else evt = await stripe.events.retrieve(String(JSON.parse(raw)?.id ?? "")); // trust only what Stripe itself returns
  } catch (_e) {
    return new Response(JSON.stringify({ error: "unverified event" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (!WEBHOOK_EVENTS.includes(evt.type)) return ok({ received: true, ignored: evt.type });

  const inv = evt.data.object as Stripe.Invoice;
  const customer = await stripe.customers.retrieve(priceIdOf(inv.customer)) as Stripe.Customer;
  const dealer = { id: customer.metadata?.dealer_id ?? "", name: customer.name ?? "" };
  const base = { event_id: evt.id, dealer_id: dealer.id, dealer_name: dealer.name, invoice_number: inv.number ?? "" };

  if (evt.type === "invoice.payment_failed") {
    const next = inv.next_payment_attempt ? `Stripe retries on ${asDate(inv.next_payment_attempt)}.` : "No more automatic retries.";
    if (!(await logActivity({ ...base, type: "payment_failed", amount: inv.amount_remaining / 100, detail: `Attempt ${inv.attempt_count}. ${next}` })))
      return ok({ received: true, duplicate: true });
    const existing = await hasOpenFollowUp(dealer.id, "payment_problem");
    const fu = existing ? { reference: existing } : await logFollowUp({ dealer, agent: "stripe", reason: "payment_problem", invoice_number: inv.number,
      amount: inv.amount_remaining / 100, summary: `Stripe webhook: automatic card payment failed on invoice ${inv.number} (attempt ${inv.attempt_count}). ${next}` }, async () => dealer);
    return ok({ received: true, type: evt.type, followup: (fu as any).reference ?? null });
  }

  // invoice.paid
  // Recovered = a card invoice that failed before (Stripe's retries, or Riley's on-demand retry after a card update).
  const recovered = inv.collection_method === "charge_automatically" && (inv.attempt_count > 1 || (await invoicesWithActivity("payment_failed")).has(inv.number ?? ""));
  const isTopup = !!Number(inv.metadata?.credit_topup_cents);
  if (!(await logActivity({ ...base, type: isTopup ? "credit_topup_paid" : recovered ? "payment_recovered" : "invoice_paid", amount: inv.amount_paid / 100,
    detail: recovered ? `Paid on attempt ${inv.attempt_count} after a failed payment.` : "" }))) return ok({ received: true, duplicate: true });
  let resolved: string[] = [];
  if (recovered || inv.attempt_count > 0) {
    const stillFailing = (await stripe.invoices.list({ customer: customer.id, status: "open", limit: 20 })).data.some((i) => i.attempt_count > 0 && i.id !== inv.id);
    if (!stillFailing) resolved = await resolveFollowUps(dealer.id, "payment_problem", `invoice ${inv.number} paid ${asDate(inv.status_transitions?.paid_at ?? null) ?? ""}`.trim());
  }
  const grant = isTopup ? await grantCreditsForInvoice(stripe, inv) : null;
  return ok({ received: true, type: evt.type, recovered, resolved_followups: resolved, credit_grant: grant });
}

/* ------------------------------------------------------- Prepaid print credits (Stripe Billing credits) */
//
// A dealer on a managed print plan can prepay for page charges. Quinn sells a block ($100 / $250 / $500) as a
// one-time Stripe invoice; when Stripe reports it paid, the service creates a "paid" credit grant scoped to metered
// prices, and Stripe draws it down automatically on page overage. Riley reads the balance straight from Stripe.

const CREDIT_BLOCKS = [10000, 25000, 50000];

async function grantsFor(stripe: Stripe, customerId: string): Promise<any[]> {
  const r = await (stripe as any).billing.creditGrants.list({ customer: customerId, limit: 100 }, CREDITS_API);
  return r.data ?? [];
}

export async function grantCreditsForInvoice(stripe: Stripe, inv: Stripe.Invoice) {
  const amt = Number(inv.metadata?.credit_topup_cents);
  if (!amt || inv.status !== "paid") return null;
  const customerId = priceIdOf(inv.customer);
  const existing = (await grantsFor(stripe, customerId)).find((g) => g.metadata?.invoice_id === inv.id);
  if (existing) return { id: existing.id, amount: amt / 100, already: true };
  const g = await (stripe as any).billing.creditGrants.create({
    customer: customerId, name: `Prepaid print credit, invoice ${inv.number}`, category: "paid",
    amount: { type: "monetary", monetary: { currency: "usd", value: amt } },
    applicability_config: { scope: { price_type: "metered" } },
    metadata: { invoice_id: inv.id, invoice_number: inv.number ?? "", source: "summit_credit_topup" },
  }, { idempotencyKey: `summit-credit-grant:${inv.id}`, ...CREDITS_API });
  return { id: g.id, amount: amt / 100, already: false };
}

const topupsOf = async (stripe: Stripe, customerId: string) =>
  (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.filter((i) => Number(i.metadata?.credit_topup_cents) > 0);

// POST /credits/buy { dealer, amount, confirmed }  -> Quinn. Without confirmed: true it only reads back the purchase.
export async function buyPrintCredits(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) return { ok: true, found: false, created: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number?` };
  const amt = Math.round(Number(String(body?.amount ?? "").replace(/[^0-9.]/g, "")) * 100);
  if (!CREDIT_BLOCKS.includes(amt)) return { ok: true, found: true, created: false,
    spoken_summary: `Prepaid print credit comes in blocks of $100, $250, or $500. Which would you like?` };
  const plan = await printPlanOf(stripe, customer.id);
  if (!plan) return { ok: true, found: true, created: false,
    spoken_summary: `Prepaid print credit only applies to managed print page charges, and ${customer.name ?? "this account"} isn't on a managed print plan yet. I can walk you through the print plans first.` };

  const prior = await topupsOf(stripe, customer.id);
  const pending = prior.find((i) => i.status === "open" && Number(i.metadata?.credit_topup_cents) === amt);
  if (pending) return { ok: true, found: true, created: false, already_pending: true, invoice_number: pending.number,
    spoken_summary: `There's already a ${money(amt)} print credit purchase waiting on invoice ${pending.number}. The credit is added as soon as that invoice is paid.` };

  if (body?.confirmed !== true && String(body?.confirmed).toLowerCase() !== "true")
    return { ok: true, found: true, created: false, needs_confirmation: true, amount: amt / 100,
      spoken_summary: `That's ${money(amt)} of prepaid print credit for ${customer.name ?? "your account"}, billed as a one-time invoice due in 7 days. `
        + `Once it's paid, Stripe adds the credit and uses it automatically on page charges over your ${plan.label} allowance. It doesn't cover the monthly base fee. Shall I send that invoice?` };

  const key = (step: string) => ({ idempotencyKey: `quinn:credits:${customer.id}:${amt}:v${prior.length}:${step}` });
  const draft = await stripe.invoices.create({
    customer: customer.id, collection_method: "send_invoice", days_until_due: 7, pending_invoice_items_behavior: "exclude",
    description: "Prepaid managed print credit, ordered by phone via Quinn. The credit is added when this invoice is paid and applies to page charges over your plan allowance.",
    metadata: { credit_topup_cents: String(amt), dealer_id: customer.metadata?.dealer_id ?? "", source: "quinn_voice_agent" },
  }, key("invoice"));
  await stripe.invoiceItems.create({ customer: customer.id, invoice: draft.id, currency: "usd", amount: amt, description: `Prepaid print credit (${money(amt)})` }, key("item"));
  const inv = await stripe.invoices.finalizeInvoice(draft.id, {}, key("finalize"));
  try { await stripe.invoices.sendInvoice(inv.id, {}, key("send")); } catch (_e) { /* finalized invoice still has its hosted link */ }
  await logActivity({ event_id: `topup:${inv.id}`, type: "credit_topup_invoiced", dealer_id: customer.metadata?.dealer_id, dealer_name: customer.name ?? "",
    invoice_number: inv.number ?? "", amount: amt / 100, detail: "Quinn sold prepaid print credit" }).catch(() => {});
  return { ok: true, found: true, created: true, invoice_number: inv.number, amount: amt / 100, hosted_invoice_url: inv.hosted_invoice_url,
    spoken_summary: `Done. Invoice ${inv.number} for ${money(amt)} of prepaid print credit is on its way to the billing email on file with a pay-online link. `
      + `As soon as it's paid, Stripe adds the ${money(amt)} credit to your account.` };
}

// POST /credits { dealer }  -> Riley (reads Stripe; also grants any paid top-up a missed webhook didn't)
export async function lookupPrintCredits(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) return { ok: true, found: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number?` };
  const topups = await topupsOf(stripe, customer.id);
  for (const i of topups.filter((i) => i.status === "paid")) await grantCreditsForInvoice(stripe, i);

  const summary = await (stripe as any).billing.creditBalanceSummary.retrieve({ customer: customer.id,
    filter: { type: "applicability_scope", applicability_scope: { price_type: "metered" } } }, CREDITS_API);
  const bal = (summary.balances ?? []).find((b: any) => b.available_balance?.monetary?.currency === "usd");
  const available = bal?.available_balance?.monetary?.value ?? 0;
  const grants = (await grantsFor(stripe, customer.id)).filter((g) => !g.voided_at);
  const granted = grants.reduce((s, g) => s + (g.amount?.monetary?.value ?? 0), 0);
  const pending = topups.filter((i) => i.status === "open");

  const name = customer.name ?? "This account";
  let spoken = granted
    ? `${name} has ${money(available)} of prepaid print credit available, out of ${money(granted)} purchased.`
    : `${name} doesn't have any prepaid print credit available yet.`;
  if (granted) spoken += ` It's applied automatically to page charges over your plan allowance on each invoice, not to the monthly base fee.`;
  if (pending.length) spoken += ` ${granted ? "There's also" : "There's"} ${pending.map((i) => `${money(Number(i.metadata!.credit_topup_cents))} on invoice ${i.number}`).join(" and ")} waiting for payment; that credit is added as soon as it's paid.`;
  return { ok: true, found: true, available: available / 100, purchased: granted / 100,
    pending_topups: pending.map((i) => ({ invoice_number: i.number, amount: Number(i.metadata!.credit_topup_cents) / 100 })), spoken_summary: spoken };
}
