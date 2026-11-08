// Summit Office Supply: failed card payments, Stripe's automatic retries, and the recovery test-clock demo.
import { Stripe, asDate, findCustomer, getStripe, priceIdOf, productFor } from "./core.ts";

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

export async function paymentFailureLine(stripe: Stripe, inv: Stripe.Invoice): Promise<string> {
  if (inv.status !== "open" || inv.collection_method !== "charge_automatically" || !inv.attempt_count) return "";
  let reason = "";
  try {
    const piId = (inv as any).payment_intent;
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(priceIdOf(piId));
      const e = pi.last_payment_error;
      reason = (e?.decline_code && DECLINES[e.decline_code]) || (e?.code && DECLINES[e.code]) || (e ? "the card was declined" : "");
    }
  } catch (_e) { /* explain without the reason */ }
  const tries = inv.attempt_count === 1 ? "one attempt so far" : `${inv.attempt_count} attempts so far`;
  const next = inv.next_payment_attempt
    ? ` Stripe will automatically try the card again on ${asDate(inv.next_payment_attempt)}.`
    : ` No more automatic retries are scheduled, so it needs to be paid online.`;
  return ` The automatic card payment for invoice ${inv.number} didn't go through${reason ? `: ${reason}` : ""}, with ${tries}.${next} To fix it, the account owner can update the card on file or pay with the pay-online link in the invoice email. I can't take card details over the phone.`;
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
