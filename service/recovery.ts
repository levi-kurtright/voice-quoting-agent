// Summit Office Supply: failed card payments, Stripe's automatic retries, and the recovery test-clock demo.
import { Stripe, asDate, findCustomer, findInvoiceByNumber, getStripe, money, priceIdOf, productFor } from "./core.ts";
import { logActivity } from "./followups.ts";

/* ------------------------------------------------- Riley: failed payments and recovery (read-only) */
//
// For card-billed (charge_automatically) invoices, Stripe retries a declined payment on its own schedule.
// Riley explains what happened and when Stripe will try again, and points the dealer to fix the card
// themselves. It never takes card details by phone.

const DECLINES: Record<string, string> = {
  insufficient_funds: "the card was declined for insufficient funds",
  expired_card: "the card on file has expired",
  card_declined: "the card was declined by the bank",
  generic_decline: "the card was declined by the bank",
  do_not_honor: "the bank declined the charge",
  lost_card: "the card on file was reported lost",
  stolen_card: "the card on file was reported stolen",
};

async function declineReason(stripe: Stripe, inv: Stripe.Invoice): Promise<string> {
  try {
    const piId = (inv as any).payment_intent;
    if (!piId) return "";
    const e = (await stripe.paymentIntents.retrieve(priceIdOf(piId))).last_payment_error;
    return (e?.decline_code && DECLINES[e.decline_code]) || (e?.code && DECLINES[e.code]) || (e ? "the card was declined" : "");
  } catch (_e) { return ""; }
}

export async function paymentFailureLine(stripe: Stripe, inv: Stripe.Invoice): Promise<string> {
  if (inv.status !== "open" || inv.collection_method !== "charge_automatically" || !inv.attempt_count) return "";
  const reason = await declineReason(stripe, inv);
  const tries = inv.attempt_count === 1 ? "one attempt so far" : `${inv.attempt_count} attempts so far`;
  const next = inv.next_payment_attempt
    ? ` Stripe will automatically try the card again on ${asDate(inv.next_payment_attempt)}.`
    : ` No more automatic retries are scheduled, so it needs to be paid online.`;
  return ` The automatic card payment for invoice ${inv.number} didn't go through${reason ? `: ${reason}` : ""}, with ${tries}.${next} To fix it, the account owner can update the card in Summit's secure online billing portal, run by Stripe, and then I can have Stripe retry the payment right away. I can't take card details over the phone.`;
}

/* --------------------------------------------- Riley: Stripe-hosted payment link (no card details by phone) */
//
// POST /payment/link { dealer, invoice_number? }
// Riley never takes a card number. Instead Stripe itself emails the invoice's secure hosted payment page to the
// billing email already on file (never to an address the caller reads out, so a caller can't redirect it).
// For card-billed subscriptions the card used on that page becomes the card for future renewals
// (payment_settings.save_default_payment_method = on_subscription). When the payment lands, the Stripe webhook
// closes the dealer's payment follow-ups, and Riley can confirm it live with check_invoice_status.
export async function sendPaymentLink(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) return { ok: true, found: false, sent: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number?` };
  const wanted = String(body?.invoice_number ?? "").trim().toUpperCase();
  let inv: Stripe.Invoice | null = null;
  if (wanted) {
    inv = await findInvoiceByNumber(stripe, wanted);
    if (inv && priceIdOf(inv.customer) !== customer.id) inv = null;
    if (!inv) return { ok: true, found: false, sent: false, spoken_summary: `I couldn't find invoice ${wanted} on this account. Could you read me the invoice number again?` };
  } else {
    const open = (await stripe.invoices.list({ customer: customer.id, status: "open", limit: 50 })).data.filter((i) => i.amount_remaining > 0);
    // A failed card payment first, then the oldest due date.
    open.sort((a, b) => Number(b.attempt_count > 0) - Number(a.attempt_count > 0) || (a.due_date ?? a.created) - (b.due_date ?? b.created));
    inv = open[0] ?? null;
    if (!inv) return { ok: true, found: true, sent: false, spoken_summary: `${customer.name ?? "This account"} has nothing open right now, so there's nothing to pay.` };
  }
  if (inv.status === "paid") return { ok: true, found: true, sent: false, invoice_number: inv.number, spoken_summary: `Invoice ${inv.number} is already paid in full, so there's nothing to send.` };
  if (inv.status !== "open") return { ok: true, found: true, sent: false, invoice_number: inv.number, spoken_summary: `Invoice ${inv.number} is ${inv.status}, so it can't be paid online. A specialist can help with that one.` };
  // Card-billed invoices: Stripe only emails pay-now links for invoices billed by email. For these, the account owner
  // updates the card in Stripe's customer portal, and Riley can then have Stripe retry the charge (POST /payment/retry).
  if (inv.collection_method === "charge_automatically") {
    let portal = "";
    try { portal = (await stripe.billingPortal.configurations.list({ active: true, limit: 20 })).data.find((c) => c.metadata?.summit === "1")?.login_page?.url ?? ""; } catch (_e) { /* optional */ }
    return { ok: true, found: true, sent: false, card_billed: true, invoice_number: inv.number, amount_due: inv.amount_remaining / 100, portal_login_url: portal || null,
      spoken_summary: `Invoice ${inv.number}, ${money(inv.amount_remaining)}, is billed to the card on file, so there's no separate pay-now link for it. `
        + `The account owner can update the card in Summit's secure online billing portal, run by Stripe. Once it's updated, I can have Stripe retry the payment right away while you're on the line.` };
  }
  if (!customer.email) return { ok: true, found: true, sent: false, needs_specialist: true, invoice_number: inv.number,
    spoken_summary: `There's no billing email on file for this account, so I can't send the payment link. I'll have a specialist reach out to update the billing contact.` };

  let sent = false, error = "";
  try {
    // Hour-scoped key: repeated asks within the hour don't send duplicate emails.
    await stripe.invoices.sendInvoice(inv.id, {}, { idempotencyKey: `riley:send-link:${inv.id}:${new Date().toISOString().slice(0, 13)}` });
    sent = true;
  } catch (e) { error = String((e as Error).message ?? e); }

  if (!sent) return { ok: true, found: true, sent: false, needs_specialist: true, invoice_number: inv.number, error,
    spoken_summary: `I wasn't able to send the payment link for invoice ${inv.number} from here. I'll have a specialist email it to the billing contact on file.` };

  await logActivity({ event_id: `link:${inv.id}:${new Date().toISOString().slice(0, 13)}`, type: "payment_link_sent", dealer_id: customer.metadata?.dealer_id,
    dealer_name: customer.name ?? "", invoice_number: inv.number ?? "", amount: inv.amount_remaining / 100, detail: "Riley had Stripe email the hosted payment page" }).catch(() => {});
  return { ok: true, found: true, sent: true, invoice_number: inv.number, amount_due: inv.amount_remaining / 100, hosted_invoice_url: inv.hosted_invoice_url,
    spoken_summary: `I've had Stripe email a secure payment link for invoice ${inv.number}, ${money(inv.amount_remaining)}, to the billing email on file for ${customer.name ?? "the account"}. `
      + `It opens Stripe's secure payment page, where the account owner can pay online. Once it's paid, I can confirm it right away if you'd like to stay on the line.` };
}

// POST /payment/retry { dealer, invoice_number?, confirmed }  -> Riley
// After the account owner updates the card, Stripe retries the failed charge on demand instead of waiting for the next
// scheduled retry. Without confirmed: true it only reads back what will be charged.
export async function retryPayment(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) return { ok: true, found: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number?` };
  const wanted = String(body?.invoice_number ?? "").trim().toUpperCase();
  const open = (await stripe.invoices.list({ customer: customer.id, status: "open", limit: 50 })).data
    .filter((i) => i.collection_method === "charge_automatically" && i.amount_remaining > 0 && (!wanted || i.number === wanted));
  const inv = open.sort((a, b) => b.attempt_count - a.attempt_count)[0];
  if (!inv) return { ok: true, found: true, retried: false,
    spoken_summary: wanted ? `I don't see a card payment waiting on invoice ${wanted}.` : `There's no failed card payment waiting on this account, so there's nothing to retry.` };

  if (body?.confirmed !== true && String(body?.confirmed).toLowerCase() !== "true")
    return { ok: true, found: true, retried: false, needs_confirmation: true, invoice_number: inv.number, amount_due: inv.amount_remaining / 100,
      spoken_summary: `I can have Stripe charge the card on file ${money(inv.amount_remaining)} now for invoice ${inv.number}. Has the account owner updated the card, and shall I go ahead?` };

  let paid: Stripe.Invoice | null = null;
  try {
    // Minute-scoped key: a double "yes" doesn't charge twice, but a later retry after another card change still runs.
    paid = await stripe.invoices.pay(inv.id, {}, { idempotencyKey: `riley:retry:${inv.id}:${new Date().toISOString().slice(0, 16)}` });
  } catch (_e) { /* declined: read the result back from Stripe below */ }
  const now = paid ?? await stripe.invoices.retrieve(inv.id);
  if (now.status === "paid") {
    const subId = (now as any).subscription;
    const subStatus = subId ? (await stripe.subscriptions.retrieve(priceIdOf(subId))).status : null;
    await logActivity({ event_id: `retry:${inv.id}:${new Date().toISOString().slice(0, 16)}`, type: "payment_retry_succeeded", dealer_id: customer.metadata?.dealer_id,
      dealer_name: customer.name ?? "", invoice_number: now.number ?? "", amount: now.amount_paid / 100, detail: "Riley had Stripe retry the card on the call" }).catch(() => {});
    return { ok: true, found: true, retried: true, paid: true, invoice_number: now.number, amount_paid: now.amount_paid / 100, subscription_status: subStatus,
      spoken_summary: `It went through. Invoice ${now.number} is paid, ${money(now.amount_paid)}${subStatus === "active" ? `, and the account is back in good standing` : ""}.` };
  }
  const why = await declineReason(stripe, now);
  const next = now.next_payment_attempt ? ` Stripe's next automatic retry is still set for ${asDate(now.next_payment_attempt)}.` : "";
  return { ok: true, found: true, retried: true, paid: false, invoice_number: now.number,
    spoken_summary: `Stripe tried the card on file just now, and it didn't go through${why ? `: ${why}` : ""}.${next} The account owner may need to update the card in the billing portal or use a different card, and then I can try again.` };
}

// POST /demo/dunning { action: "setup" | "advance" | "break-card" | "fix-card" | "status", frozen_time?, to? }
// (admin, test mode only) A card-billed demo dealer on its own test clock, to show a failed renewal and recovery.
// Uses Stripe's built-in test payment methods (pm_card_visa, pm_card_chargeCustomerFail); no card numbers anywhere.
const DUNNING_DEALER = { id: "D-3002", name: "Eastgate Business Supply", email: "ap@eastgate-supply.example" };
export async function demoDunning(body: any) {
  const stripe = getStripe();
  const action = String(body?.action ?? "status");
  let customer = await findCustomer(stripe, { id: DUNNING_DEALER.id });
  const setDefaultCard = async (cust: string, testPm: string) => {
    const pm = await stripe.paymentMethods.attach(testPm, { customer: cust });
    await stripe.customers.update(cust, { invoice_settings: { default_payment_method: pm.id } });
    // A card saved on the subscription (save_default_payment_method) takes precedence, so point it at the same card.
    for (const s of (await stripe.subscriptions.list({ customer: cust, limit: 10 })).data)
      if (s.default_payment_method) await stripe.subscriptions.update(s.id, { default_payment_method: pm.id });
    return pm.id;
  };
  if (action === "setup" && !customer) {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Number(body?.frozen_time), name: "Eastgate failed-payment demo" },
      { idempotencyKey: `summit-dunning-clock:${body?.frozen_time}` });
    customer = await stripe.customers.create({
      name: DUNNING_DEALER.name, email: DUNNING_DEALER.email, test_clock: clock.id,
      metadata: { dealer_id: DUNNING_DEALER.id, source: "summit_demo" },
    }, { idempotencyKey: `summit-dunning-customer:${clock.id}` });
    await setDefaultCard(customer.id, "pm_card_visa");
    await stripe.subscriptions.create({
      customer: customer.id, collection_method: "charge_automatically",
      items: [{ quantity: 6, price_data: { currency: "usd", product: await productFor(stripe, "Toner subscription — per printer / month"), unit_amount: 3325, recurring: { interval: "month" } } }],
      metadata: { source: "summit_demo", term_months: "12" },
    }, { idempotencyKey: `summit-dunning-sub:${customer.id}` });
  }
  if (!customer) throw new Error("Dunning demo dealer not set up yet");
  if (action === "break-card") await setDefaultCard(customer.id, "pm_card_chargeCustomerFail");
  if (action === "fix-card") await setDefaultCard(customer.id, "pm_card_visa");
  const clockId = priceIdOf((customer as any).test_clock);
  if (action === "advance") await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: Number(body?.to) });
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 5 });
  const invoices = await stripe.invoices.list({ customer: customer.id, limit: 10 });
  return { ok: true, customer_id: customer.id, clock_id: clock.id, clock_status: clock.status, frozen_date: asDate(clock.frozen_time), frozen_time: clock.frozen_time,
    subscription_status: subs.data.map((s) => s.status),
    invoices: invoices.data.map((i) => ({ number: i.number, status: i.status, total: i.total / 100, attempt_count: i.attempt_count, next_payment_attempt: asDate(i.next_payment_attempt), billing_reason: i.billing_reason })) };
}
