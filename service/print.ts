// Summit Office Supply: managed print plans, usage-based billing on Stripe Billing meters, and the test-clock demo.
import { Stripe, asDate, findCustomer, getStripe, money, priceIdOf, productFor } from "./core.ts";

/* ------------------------------------------- Managed print: usage-based billing (Stripe Billing meters) */
//
// Two managed print plans, both metered on one "pages_printed" meter and billed in arrears by Stripe:
//   5K:  $49/month,  5,000 pages included, then 1.2 cents a page
//   25K: $199/month, 25,000 pages included, then 0.9 cents a page   (cheaper above ~17,500 pages a month)
//   POST /usage/setup         -> (admin) ensure meter + prices exist, put a dealer on a plan
//   POST /usage/report        -> (printer feed) record pages printed as a meter event
//   POST /usage               -> Riley: pages this period, overage so far, Stripe's next-invoice estimate (read-only)
//   POST /usage/plan-options  -> Quinn: compare this period on both plans (read-only)
//   POST /usage/plan-change   -> Quinn: switch plans at the next billing period via a subscription schedule
//   POST /demo/clock          -> (admin) test-clock demo dealer: setup / advance / status

const PRINT_EVENT = "pages_printed";
type PlanKey = "5k" | "25k";
type PrintPlan = { key: PlanKey; label: string; included: number; baseCents: number; overageCents: number; rateSpoken: string; baseLookup: string; pagesLookup: string; baseProduct: string };
const PRINT_PLANS: Record<PlanKey, PrintPlan> = {
  "5k": { key: "5k", label: "Managed Print 5K", included: 5000, baseCents: 4900, overageCents: 1.2, rateSpoken: "one point two cents",
    baseLookup: "managed_print_5k_base", pagesLookup: "managed_print_5k_pages", baseProduct: "Managed print plan, monthly base (5,000 pages included)" },
  "25k": { key: "25k", label: "Managed Print 25K", included: 25000, baseCents: 19900, overageCents: 0.9, rateSpoken: "zero point nine cents",
    baseLookup: "managed_print_25k_base", pagesLookup: "managed_print_25k_pages", baseProduct: "Managed print plan 25K, monthly base (25,000 pages included)" },
};
const pagesFmt = (n: number) => Math.round(n).toLocaleString("en-US");
const planCost = (p: PrintPlan, pages: number) => p.baseCents + Math.round(Math.max(0, pages - p.included) * p.overageCents);

type PrintCatalog = { meter: Stripe.Billing.Meter; prices: Record<PlanKey, { base: Stripe.Price; pages: Stripe.Price }> };

export async function ensurePrintCatalog(stripe: Stripe): Promise<PrintCatalog> {
  const meters = await stripe.billing.meters.list({ status: "active", limit: 100 });
  const meter = meters.data.find((m) => m.event_name === PRINT_EVENT) ?? await stripe.billing.meters.create({
    display_name: "Pages printed", event_name: PRINT_EVENT,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  }, { idempotencyKey: "summit-meter:pages_printed:v1" });

  const keys = Object.values(PRINT_PLANS).flatMap((p) => [p.baseLookup, p.pagesLookup]);
  const found = await stripe.prices.list({ lookup_keys: keys, active: true, limit: 20 });
  const prices = {} as PrintCatalog["prices"];
  for (const p of Object.values(PRINT_PLANS)) {
    const base = found.data.find((x) => x.lookup_key === p.baseLookup) ?? await stripe.prices.create({
      product: await productFor(stripe, p.baseProduct), currency: "usd", unit_amount: p.baseCents,
      recurring: { interval: "month" }, lookup_key: p.baseLookup, nickname: `${p.label} base`,
    }, { idempotencyKey: `summit-price:${p.baseLookup}:v1` });
    const pages = found.data.find((x) => x.lookup_key === p.pagesLookup) ?? await stripe.prices.create({
      product: await productFor(stripe, "Managed print pages"), currency: "usd",
      recurring: { interval: "month", usage_type: "metered", meter: meter.id } as any,
      billing_scheme: "tiered", tiers_mode: "graduated",
      tiers: [{ up_to: p.included, unit_amount: 0 }, { up_to: "inf", unit_amount_decimal: String(p.overageCents) }],
      lookup_key: p.pagesLookup, nickname: `${p.label} pages (${pagesFmt(p.included)} included, then ${p.overageCents} cents)`,
    }, { idempotencyKey: `summit-price:${p.pagesLookup}:v1` });
    prices[p.key] = { base, pages };
  }
  return { meter, prices };
}

const planOfPrice = (cat: PrintCatalog, priceId: string): PrintPlan | null =>
  (Object.keys(cat.prices) as PlanKey[]).map((k) => (cat.prices[k].pages.id === priceId ? PRINT_PLANS[k] : null)).find(Boolean) ?? null;

async function findPrintSubscription(stripe: Stripe, customerId: string, cat: PrintCatalog) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  for (const s of subs.data) {
    if (!["active", "trialing", "past_due", "unpaid"].includes(s.status)) continue;
    const item = s.items.data.find((i) => planOfPrice(cat, i.price.id));
    if (item) return { sub: s, item, plan: planOfPrice(cat, item.price.id)! };
  }
  return null;
}

// "Now" for this customer: a test-clock customer lives at the clock's frozen time.
async function customerNow(stripe: Stripe, customer: Stripe.Customer): Promise<number> {
  const tc = (customer as any).test_clock;
  if (tc) return (await stripe.testHelpers.testClocks.retrieve(priceIdOf(tc))).frozen_time;
  return Math.floor(Date.now() / 1000);
}

// Shared by Riley's usage lookup and Quinn's plan tools.
async function printContext(stripe: Stripe, body: any) {
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) return { stop: `I couldn't find an account for that dealer. Can you give me the dealer number?` };
  const cat = await ensurePrintCatalog(stripe);
  const found = await findPrintSubscription(stripe, customer.id, cat);
  if (!found) return { stop: `${customer.name ?? "That account"} isn't on a managed print plan, so there's no page usage to report.`, on_plan: false };
  const { sub, item, plan } = found;

  const currentStart: number = (item as any).current_period_start ?? (sub as any).current_period_start;
  const periodEnd: number = (item as any).current_period_end ?? (sub as any).current_period_end;
  // A backdated subscription's first invoice also bills usage from start_date, before the first period began.
  const periodStart = sub.created >= currentStart - 3600 && sub.start_date < currentStart ? sub.start_date : currentStart;
  const now = Math.min(await customerNow(stripe, customer), periodEnd);

  const minute = (t: number, up = false) => (up ? Math.ceil(t / 60) : Math.floor(t / 60)) * 60;
  const sums = await stripe.billing.meters.listEventSummaries(cat.meter.id, {
    customer: customer.id, start_time: minute(periodStart), end_time: Math.max(minute(periodStart) + 60, minute(now, true)),
  });
  const used = Math.round(sums.data.reduce((s, x) => s + x.aggregated_value, 0));
  const elapsed = Math.max(1, now - periodStart), length = Math.max(1, periodEnd - periodStart);
  const projected = Math.max(used, Math.round(used * Math.min(length / elapsed, 31)));

  // A plan switch already scheduled for the next period?
  let scheduled: PrintPlan | null = null;
  if (sub.schedule) {
    const sched = await stripe.subscriptionSchedules.retrieve(priceIdOf(sub.schedule));
    const next = sched.phases.find((ph) => ph.start_date >= periodEnd - 60);
    const p = next?.items.map((i) => planOfPrice(cat, priceIdOf(i.price))).find(Boolean);
    if (p && p.key !== plan.key) scheduled = p;
  }
  return { customer, cat, sub, item, plan, periodStart, periodEnd, now, used, projected, scheduled };
}

// POST /usage/setup { dealer, plan?, start_date? }  (admin/test setup, not exposed to the agents)
export async function setupPrintPlan(body: any) {
  const stripe = getStripe();
  const cat = await ensurePrintCatalog(stripe);
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) throw new Error("Dealer not found");
  const plan = PRINT_PLANS[(String(body?.plan ?? "5k").toLowerCase() as PlanKey)] ?? PRINT_PLANS["5k"];
  const existing = await findPrintSubscription(stripe, customer.id, cat);
  let sub = existing?.sub;
  if (!sub) {
    const start = Number(body?.start_date) || undefined;
    sub = await stripe.subscriptions.create({
      customer: customer.id, items: [{ price: cat.prices[plan.key].base.id }, { price: cat.prices[plan.key].pages.id }],
      collection_method: "send_invoice", days_until_due: 30,
      ...(start ? { backdate_start_date: start } : {}),
      metadata: { plan: `managed_print_${plan.key}`, source: "summit_setup" },
    }, { idempotencyKey: `summit-print-sub:${customer.id}:v1` });
  }
  return { ok: true, meter_id: cat.meter.id, plan: existing?.plan.key ?? plan.key, subscription_id: sub.id, customer: customer.name,
    prices: Object.fromEntries(Object.entries(cat.prices).map(([k, v]) => [k, { base: v.base.id, pages: v.pages.id }])) };
}

// POST /usage/report { dealer, pages, printer_id?, timestamp?, event_id? }  (simulated printer telemetry)
export async function reportPrintUsage(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? {});
  if (!customer) throw new Error("Dealer not found");
  const value = Math.round(Number(body?.pages));
  if (!(value > 0)) throw new Error("pages must be a positive number");
  const now = Math.floor(Date.now() / 1000);
  const ts = Math.min(Number(body?.timestamp) || now, now);
  const identifier = String(body?.event_id ?? `${customer.id}:${body?.printer_id ?? "printer"}:${ts}:${value}`).slice(0, 100);
  await stripe.billing.meterEvents.create({
    event_name: PRINT_EVENT, timestamp: ts, identifier,
    payload: { stripe_customer_id: customer.id, value: String(value), printer_id: String(body?.printer_id ?? "") },
  });
  return { ok: true, recorded: value, identifier, timestamp: ts };
}

// POST /usage { dealer }  -> Riley (read-only)
export async function lookupPrintUsage(body: any) {
  const stripe = getStripe();
  const c: any = await printContext(stripe, body);
  if (c.stop) return { ok: true, found: c.on_plan !== undefined, on_plan: false, spoken_summary: c.stop };
  const { customer, sub, plan, periodStart, periodEnd, now, used, projected, scheduled } = c;
  const over = Math.max(0, used - plan.included);
  const overCents = Math.round(over * plan.overageCents);
  const projOverCents = Math.round(Math.max(0, projected - plan.included) * plan.overageCents);

  // Stripe's own preview of the next invoice (usage for this period plus next month's base).
  let preview: Stripe.Invoice | null = null;
  try { preview = await (stripe.invoices as any).createPreview({ customer: customer.id, subscription: sub.id }); } catch (_e) { /* estimate below still stands */ }

  const name = customer.name ?? "Your account";
  let spoken = `${name} is on the ${plan.label} plan and has printed ${pagesFmt(used)} pages since ${asDate(periodStart)}.`;
  spoken += over > 0
    ? ` That's ${pagesFmt(over)} pages over the ${pagesFmt(plan.included)} included, about ${money(overCents)} in overage so far at ${plan.rateSpoken} a page.`
    : ` That's within the ${pagesFmt(plan.included)} pages included in your plan, so there's no overage so far.`;
  if (preview) {
    // Describe only what Stripe's preview actually contains.
    const baseInPreview = (preview.lines?.data ?? []).filter((l: any) => l.price?.recurring?.usage_type !== "metered").reduce((s, l) => s + l.amount, 0);
    spoken += ` Right now, Stripe estimates your next invoice on ${asDate(periodEnd)} at ${money(preview.total)}`
      + (baseInPreview > 0 ? `, which includes ${money(baseInPreview)} for next month's base fee.` : `, for this period's page usage.`);
  }
  if (projected > used) spoken += ` At your current pace you'd finish the period around ${pagesFmt(projected)} pages, or roughly ${money(projOverCents)} in overage. That's an estimate.`;
  if (scheduled) spoken += ` Your switch to the ${scheduled.label} plan starts on ${asDate(periodEnd)}.`;
  return { ok: true, found: true, on_plan: true, plan: plan.key, subscription_id: sub.id,
    period_start: asDate(periodStart), period_end: asDate(periodEnd), as_of: asDate(now), pages_used: used, pages_included: plan.included,
    overage_pages: over, overage_so_far: overCents / 100, projected_pages: projected, projected_overage: projOverCents / 100,
    next_invoice_estimate: preview ? preview.total / 100 : null, scheduled_plan: scheduled?.key ?? null, spoken_summary: spoken };
}

// POST /usage/plan-options { dealer }  -> Quinn (read-only): this period priced on both plans
export async function printPlanOptions(body: any) {
  const stripe = getStripe();
  const c: any = await printContext(stripe, body);
  if (c.stop) return { ok: true, found: false, spoken_summary: c.stop };
  const { plan, periodEnd, projected, scheduled } = c;
  const other = PRINT_PLANS[plan.key === "5k" ? "25k" : "5k"];
  const curCost = planCost(plan, projected), otherCost = planCost(other, projected);
  const small = PRINT_PLANS["5k"], big = PRINT_PLANS["25k"];
  const breakeven = Math.round(small.included + (big.baseCents - small.baseCents) / small.overageCents);
  const better = otherCost < curCost;

  let spoken = `At your current pace of about ${pagesFmt(projected)} pages this period, the ${plan.label} plan comes to about ${money(curCost)}, and the ${other.label} plan would be about ${money(otherCost)}.`;
  if (scheduled) spoken += ` You already have a switch to the ${scheduled.label} plan scheduled for ${asDate(periodEnd)}.`;
  else if (better) spoken += ` The ${other.label} plan would save roughly ${money(curCost - otherCost)} a month at that volume. The switch would start on ${asDate(periodEnd)}, at your next billing period, and this period's pages stay on your current plan. That's an estimate based on your printing so far. Would you like me to schedule the switch?`;
  else spoken += ` Your current plan is the better fit at this volume. The 25K plan only comes out ahead above about ${pagesFmt(breakeven)} pages a month.`;
  return { ok: true, found: true, current_plan: plan.key, recommended_plan: better ? other.key : plan.key, basis_pages: projected,
    current_plan_cost: curCost / 100, other_plan_cost: otherCost / 100, breakeven_pages: breakeven,
    effective_date: asDate(periodEnd), already_scheduled: scheduled?.key ?? null, spoken_summary: spoken };
}

// POST /usage/plan-change { dealer, plan: "5k" | "25k" }  -> Quinn, after the caller says yes
export async function changePrintPlan(body: any) {
  const stripe = getStripe();
  const target = PRINT_PLANS[(String(body?.plan ?? "").toLowerCase().replace(/[^0-9k]/g, "") as PlanKey)];
  if (!target) return { ok: true, changed: false, spoken_summary: `Which plan would you like: the 5K plan or the 25K plan?` };
  const c: any = await printContext(stripe, body);
  if (c.stop) return { ok: true, changed: false, spoken_summary: c.stop };
  const { cat, sub, plan, periodEnd, now, scheduled } = c;
  if (scheduled?.key === target.key)
    return { ok: true, changed: true, already_scheduled: true, spoken_summary: `Your switch to the ${target.label} plan is already scheduled for ${asDate(periodEnd)}. Nothing more is needed.` };
  if (plan.key === target.key && !scheduled)
    return { ok: true, changed: false, spoken_summary: `You're already on the ${target.label} plan, so there's nothing to change.` };

  // Change at renewal: keep the current phase as-is, then start a phase on the target plan's prices.
  const schedule = sub.schedule
    ? await stripe.subscriptionSchedules.retrieve(priceIdOf(sub.schedule))
    : await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `quinn:print-sched:${sub.id}` });
  const cur = schedule.phases.find((ph) => ph.start_date <= now && ph.end_date > now) ?? schedule.phases[0];
  const isMetered = (id: string) => Object.values(cat.prices).some((p: any) => p.pages.id === id);
  const keepItems = cur.items.map((i) => {
    const id = priceIdOf(i.price);
    return isMetered(id) ? { price: id } : { price: id, quantity: i.quantity ?? 1 };
  });
  const tp = cat.prices[target.key];
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release", proration_behavior: "none",
    phases: [
      { items: keepItems, start_date: cur.start_date, end_date: cur.end_date },
      { items: [{ price: tp.base.id, quantity: 1 }, { price: tp.pages.id }], iterations: 1, metadata: { plan: `managed_print_${target.key}`, changed_by: "quinn_voice_agent" } },
    ],
  } as any, { idempotencyKey: `quinn:print-plan:${sub.id}:${cur.end_date}:${target.key}` });

  return { ok: true, changed: true, plan: target.key, effective_date: asDate(cur.end_date), schedule_id: schedule.id,
    spoken_summary: `Done. Your switch to the ${target.label} plan is scheduled for ${asDate(cur.end_date)}. Until then you stay on the ${plan.label} plan, and this period's pages are billed at your current rates. Starting then, it's ${money(target.baseCents)} a month with ${pagesFmt(target.included)} pages included, then ${target.rateSpoken} a page.` };
}

// Riley: when an invoice includes metered print usage, explain it in plain words.
export async function explainUsageInvoice(stripe: Stripe, inv: Stripe.Invoice): Promise<string> {
  try {
    const lines = await stripe.invoices.listLineItems(inv.id, { limit: 50 });
    const metered = lines.data.filter((l: any) => l.price?.recurring?.usage_type === "metered");
    if (!metered.length) return "";
    const pages = metered.reduce((s, l) => s + (l.quantity ?? 0), 0);
    const usageCents = metered.reduce((s, l) => s + l.amount, 0);
    const plan = PRINT_PLANS[(Object.keys(PRINT_PLANS) as PlanKey[]).find((k) => metered.some((l: any) => l.price?.lookup_key === PRINT_PLANS[k].pagesLookup)) ?? "5k"];
    const otherCents = lines.data.filter((l: any) => l.price?.recurring?.usage_type !== "metered").reduce((s, l) => s + l.amount, 0);
    const p = metered[0].period;
    let out = ` It covers ${pagesFmt(pages)} pages printed from ${asDate(p.start)} to ${asDate(p.end)}`;
    out += pages > plan.included
      ? `: ${pagesFmt(plan.included)} included, and ${pagesFmt(pages - plan.included)} at ${plan.rateSpoken} a page, for ${money(usageCents)}.`
      : `, all within the ${pagesFmt(plan.included)} included pages.`;
    if (otherCents) out += ` The rest, ${money(otherCents)}, is the plan's monthly base fee${inv.discount || (inv as any).discounts?.length ? " after discounts" : ""}.`;
    return out;
  } catch (_e) { return ""; }
}

// POST /demo/clock { action: "setup" | "advance" | "status", frozen_time?, to? }  (admin, test mode only)
// A Stripe test clock lets the demo dealer live through a whole billing month in minutes.
const DEMO_DEALER = { id: "D-3001", name: "Northside Print Co.", email: "ap@northside-print.example" };
export async function demoClock(body: any) {
  const stripe = getStripe();
  const action = String(body?.action ?? "status");
  let customer = await findCustomer(stripe, { id: DEMO_DEALER.id });
  if (action === "setup" && !customer) {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Number(body?.frozen_time), name: "Northside managed print demo" },
      { idempotencyKey: `summit-demo-clock:${body?.frozen_time}` });
    customer = await stripe.customers.create({
      name: DEMO_DEALER.name, email: DEMO_DEALER.email, test_clock: clock.id,
      metadata: { dealer_id: DEMO_DEALER.id, source: "summit_demo" },
    }, { idempotencyKey: `summit-demo-customer:${clock.id}` });
    const cat = await ensurePrintCatalog(stripe);
    await stripe.subscriptions.create({
      customer: customer.id, items: [{ price: cat.prices["5k"].base.id }, { price: cat.prices["5k"].pages.id }],
      collection_method: "send_invoice", days_until_due: 30, metadata: { plan: "managed_print_5k", source: "summit_demo" },
    }, { idempotencyKey: `summit-demo-sub:${customer.id}` });
  }
  if (!customer) throw new Error("Demo dealer not set up yet");
  const clockId = priceIdOf((customer as any).test_clock);
  if (action === "advance") await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: Number(body?.to) });
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  const invoices = await stripe.invoices.list({ customer: customer.id, limit: 10 });
  return { ok: true, customer_id: customer.id, clock_id: clock.id, clock_status: clock.status, frozen_time: clock.frozen_time, frozen_date: asDate(clock.frozen_time),
    invoices: invoices.data.map((i) => ({ number: i.number, status: i.status, total: i.total / 100, billing_reason: i.billing_reason, created: asDate(i.created) })) };
}
