// Summit Office Supply: what a dealer's plans include (Stripe Entitlements) and pausing instead of canceling.
//   Plan features   POST /plan/features        Riley  features of each plan the dealer has, read from Stripe (read-only)
//   Pause billing   POST /subscription/pause   Quinn  pause a toner subscription for one or two billing months
//                                                     (reads back first; pauses only on confirmed: true)
//   Setup           ensurePlanFeatures()       run by POST /demo/stripe-setup (admin): Entitlements features on the catalog
import { Stripe, asDate, findCustomer, getStripe, money, priceIdOf } from "./core.ts";

/* ------------------------------------------------------------- plan features (Stripe Entitlements) */
//
// Each thing a plan includes is a Stripe Entitlements feature attached to the product, so Stripe, not this code,
// is the record of what a dealer gets. Riley reads the features straight off the products the dealer subscribes to,
// and reports Stripe's active entitlements alongside. (Stripe refreshes active entitlements for existing
// subscriptions at their next billing period, so the product features are the immediate source.)

// name = the Stripe feature name; say = how Riley speaks it. Listed in the order Riley reads them.
const FEATURES: { key: string; name: string; say: string }[] = [
  { key: "pages-5k", name: "5,000 pages a month included", say: "5,000 pages a month" },
  { key: "pages-25k", name: "25,000 pages a month included", say: "25,000 pages a month" },
  { key: "toner-included", name: "Toner included", say: "toner" },
  { key: "toner-auto-ship", name: "Automatic toner shipments for every printer on the subscription", say: "automatic toner shipments for every printer" },
  { key: "repair-next-day", name: "Next-business-day printer repair", say: "next-business-day printer repair" },
  { key: "repair-same-day", name: "Same-day printer repair", say: "same-day printer repair" },
  { key: "usage-review", name: "A quarterly print usage review", say: "a quarterly print usage review" },
];
const order = (key: string) => { const i = FEATURES.findIndex((f) => f.key === key); return i < 0 ? 99 : i; };
const say = (f: { key: string; name: string }) => FEATURES.find((x) => x.key === f.key)?.say ?? f.name.toLowerCase();
const speakList = (fs: { key: string; name: string }[]) => joinAnd([...fs].sort((a, b) => order(a.key) - order(b.key)).map(say));

// Products are matched by name, so every wording of the toner subscription product gets the same feature.
type Family = { family: "toner" | "print_5k" | "print_25k"; label: string; match: RegExp; keys: string[] };
const FAMILIES: Family[] = [
  { family: "toner", label: "toner subscription", match: /^toner subscription/i, keys: ["toner-auto-ship"] },
  { family: "print_5k", label: "5K managed print plan", match: /^managed print plan, monthly base/i, keys: ["pages-5k", "toner-included", "repair-next-day"] },
  { family: "print_25k", label: "25K managed print plan", match: /^managed print plan 25k/i, keys: ["pages-25k", "toner-included", "repair-same-day", "usage-review"] },
];
const familyOf = (productName: string) => FAMILIES.find((f) => f.match.test(productName)) ?? null;

// Idempotent: creates any missing features and attaches them to every matching active product.
export async function ensurePlanFeatures(stripe: Stripe) {
  const ids = new Map<string, string>();
  for await (const f of stripe.entitlements.features.list({ limit: 100 })) ids.set(f.lookup_key, f.id);
  for (const f of FEATURES) if (!ids.has(f.key))
    ids.set(f.key, (await stripe.entitlements.features.create({ lookup_key: f.key, name: f.name }, { idempotencyKey: `summit-feature:${f.key}` })).id);
  let attached = 0;
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    const fam = familyOf(p.name);
    if (!fam) continue;
    const have = new Set((await stripe.products.listFeatures(p.id, { limit: 100 })).data.map((pf) => pf.entitlement_feature.lookup_key));
    for (const k of fam.keys) if (!have.has(k)) { await stripe.products.createFeature(p.id, { entitlement_feature: ids.get(k)! }); attached++; }
  }
  return { features: ids.size, newly_attached: attached };
}

function joinAnd(xs: string[]): string {
  return xs.length < 2 ? (xs[0] ?? "") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
}

// POST /plan/features { dealer }  -> Riley (read-only)
export async function lookupPlanFeatures(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? body);
  if (!customer) return { ok: true, found: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number or the email on the account?` };
  const name = customer.name || "That account";

  const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 20 });
  const live = subs.data.filter((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
  const featureCache = new Map<string, { key: string; name: string }[]>();
  const featuresOf = async (productId: string) => {
    if (!featureCache.has(productId)) featureCache.set(productId, (await stripe.products.listFeatures(productId, { limit: 100 })).data
      .map((pf) => ({ key: pf.entitlement_feature.lookup_key, name: pf.entitlement_feature.name })));
    return featureCache.get(productId)!;
  };

  const plans: any[] = [];
  for (const s of live) for (const it of s.items.data) {
    if (it.price.recurring?.usage_type === "metered") continue; // page charges belong to the plan's base item
    const productId = priceIdOf(it.price.product);
    const product = await stripe.products.retrieve(productId);
    const features = await featuresOf(productId);
    const fam = familyOf(product.name);
    if (!fam || !features.length) continue;
    plans.push({ subscription_id: s.id, family: fam.family, label: fam.label, product: product.name, quantity: it.quantity ?? 1, features,
      billing_paused: !!s.pause_collection });
  }
  const active = (await stripe.entitlements.activeEntitlements.list({ customer: customer.id, limit: 100 })).data.map((e) => e.lookup_key);

  if (!plans.length) return { ok: true, found: true, customer_id: customer.id, plans, active_entitlements: active,
    spoken_summary: `${name} doesn't have a plan with listed features right now.` };

  const parts: string[] = [];
  for (const fam of FAMILIES) {
    const mine = plans.filter((p) => p.family === fam.family);
    if (!mine.length) continue;
    const feats = speakList(mine[0].features);
    if (fam.family === "toner") {
      const printers = mine.reduce((a, p) => a + p.quantity, 0);
      parts.push(mine.length === 1
        ? `The toner subscription for ${printers} printer${printers === 1 ? "" : "s"} includes ${feats}.`
        : `The ${mine.length} toner subscriptions, covering ${printers} printers in all, include ${feats}.`);
    } else parts.push(`The ${fam.label} includes ${feats}.`);
    if (mine.some((p) => p.billing_paused)) parts.push(`Billing on ${mine.length === 1 ? "it" : "one of them"} is paused right now.`);
  }

  // A dealer on the 5K plan hears what the 25K plan adds; Quinn compares the cost and makes any switch.
  let upgrade: any = null;
  if (plans.some((p) => p.family === "print_5k") && !plans.some((p) => p.family === "print_25k")) {
    for await (const p of stripe.products.list({ active: true, limit: 100 })) {
      if (familyOf(p.name)?.family !== "print_25k") continue;
      const mineKeys = new Set(plans.filter((x) => x.family === "print_5k").flatMap((x) => x.features.map((f: any) => f.key)));
      const adds = (await featuresOf(p.id)).filter((f) => !mineKeys.has(f.key));
      if (adds.length) upgrade = { to: "25K managed print plan", adds };
      break;
    }
    if (upgrade) {
      const pages = upgrade.adds.filter((f: any) => f.key.startsWith("pages-"));
      const extra = upgrade.adds.filter((f: any) => !f.key.startsWith("pages-"));
      const what = [pages.length ? `includes ${speakList(pages)}` : "", extra.length ? `adds ${speakList(extra)}` : ""].filter(Boolean).join(" and ");
      parts.push(`The 25K plan ${what}. Quinn can compare the cost for you.`);
    }
  }
  return { ok: true, found: true, customer_id: customer.id, plans, active_entitlements: active, upgrade,
    spoken_summary: `Here's what ${name}'s plans include. ${parts.join(" ")}` };
}

/* ------------------------------------------------------------- Quinn: pause instead of cancel */
//
// Summit's phone policy: a toner subscription can be paused for one or two billing months, once a year. Stripe
// pauses payment collection and voids the invoices for the skipped months, then resumes on its own. Print plans,
// longer pauses and cancellations go to a specialist.

const DAY = 86400;
function addMonths(unix: number, n: number): number {
  const d = new Date(unix * 1000);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return Math.floor(t.getTime() / 1000);
}

// POST /subscription/pause { dealer, months: 1 | 2, printers?, confirmed }  -> Quinn
export async function pauseSubscription(body: any) {
  const stripe = getStripe();
  const customer = await findCustomer(stripe, body?.dealer ?? body);
  if (!customer) return { ok: true, found: false, paused: false, spoken_summary: `I couldn't find an account for that dealer. Can you give me the dealer number or the email on the account?` };
  const name = customer.name || "That account";
  const months = Math.round(Number(body?.months ?? 1));
  if (months !== 1 && months !== 2)
    return { ok: true, found: true, paused: false, needs_specialist: true, spoken_summary: `I can pause billing for one or two months. For anything longer, a specialist will follow up.` };

  const subs = await stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 20 });
  const toner: { sub: Stripe.Subscription; printers: number }[] = [];
  for (const s of subs.data) {
    if (s.items.data.length !== 1) continue;
    const it = s.items.data[0];
    if (it.price.recurring?.usage_type === "metered") continue;
    const p = await stripe.products.retrieve(priceIdOf(it.price.product));
    if (familyOf(p.name)?.family === "toner") toner.push({ sub: s, printers: it.quantity ?? 1 });
  }
  if (!toner.length) return { ok: true, found: true, paused: false, needs_specialist: true,
    spoken_summary: `${name} doesn't have a toner subscription I can pause, and print plans can't be paused by phone. A specialist can help with that.` };

  const sizes = joinAnd(toner.map((t) => String(t.printers)));
  const want = body?.printers != null && body.printers !== "" ? Math.round(Number(body.printers)) : null;
  const matches = want ? toner.filter((t) => t.printers === want) : toner;
  if (!matches.length) return { ok: true, found: true, paused: false, needs_choice: true,
    spoken_summary: `I don't see a toner subscription for ${want} printers. ${name}'s toner subscriptions cover ${sizes} printers. Which one should I pause?` };
  if (matches.length > 1 && !want) return { ok: true, found: true, paused: false, needs_choice: true, options: toner.map((t) => ({ printers: t.printers })),
    spoken_summary: `${name} has ${toner.length} toner subscriptions, for ${sizes} printers. Which one should I pause?` };
  if (matches.length > 1) return { ok: true, found: true, paused: false, needs_specialist: true,
    spoken_summary: `${name} has more than one toner subscription for ${want} printers, so I'll have a specialist make this change to be safe.` };

  const { sub, printers } = matches[0];
  const label = `toner subscription for ${printers} printer${printers === 1 ? "" : "s"}`;
  if (sub.pause_collection) {
    const restart = Number(sub.metadata?.pause_restarts_with) || null;
    return { ok: true, found: true, paused: true, already_paused: true, subscription_id: sub.id,
      spoken_summary: `Billing on your ${label} is already paused${restart ? `. It restarts with the ${asDate(restart)} invoice` : ""}.` };
  }
  if (sub.schedule) return { ok: true, found: true, paused: false, needs_specialist: true,
    spoken_summary: `Your ${label} already has a scheduled change, so a specialist will need to set up the pause.` };
  const lastPause = Number(sub.metadata?.last_pause_at ?? 0);
  if (lastPause && Date.now() / 1000 - lastPause < 365 * DAY) return { ok: true, found: true, paused: false, needs_specialist: true,
    spoken_summary: `Your ${label} was already paused in the last twelve months, so a specialist will need to approve another pause.` };

  const periodEnd = Number((sub as any).current_period_end ?? (sub.items.data[0] as any).current_period_end);
  const skipped = Array.from({ length: months }, (_, k) => addMonths(periodEnd, k));
  const restartsWith = addMonths(periodEnd, months);
  const resumesAt = skipped[months - 1] + DAY; // after the last skipped renewal, before the next one
  const skippedSpoken = joinAnd(skipped.map((t) => asDate(t)!));
  const invoices = months === 1 ? "invoice" : "invoices";

  // The regular monthly amount comes from Stripe's own next-invoice preview (discounts and tax included).
  let monthly = (sub.items.data[0].price.unit_amount ?? 0) * printers;
  try { monthly = (await (stripe.invoices as any).createPreview({ customer: customer.id, subscription: sub.id })).total; } catch (_e) { /* fall back to list price */ }

  const facts = { subscription_id: sub.id, printers, months, skipped_invoice_dates: skipped.map(asDate), restarts_with_invoice_on: asDate(restartsWith), monthly_amount: monthly / 100 };
  const confirmed = body?.confirmed === true || body?.confirmed === "true";
  if (!confirmed) return { ok: true, found: true, paused: false, confirmed: false, ...facts,
    spoken_summary: `I can pause billing on your ${label} for ${months === 1 ? "one month" : "two months"}. Stripe will skip the ${skippedSpoken} ${invoices}, and toner shipments stop during the pause. Billing restarts automatically with the ${asDate(restartsWith)} invoice, at ${money(monthly)} a month. Anything you already owe isn't affected. Would you like me to pause it?` };

  await stripe.subscriptions.update(sub.id, {
    pause_collection: { behavior: "void", resumes_at: resumesAt },
    metadata: { ...sub.metadata, last_pause_at: String(Math.floor(Date.now() / 1000)), pause_restarts_with: String(restartsWith), last_change: `paused ${months} month(s) via quinn_voice_agent` },
  }, { idempotencyKey: `quinn:pause:${sub.id}:${periodEnd}:${months}` });
  return { ok: true, found: true, paused: true, ...facts,
    spoken_summary: `Done. Billing on your ${label} is paused. Stripe will skip the ${skippedSpoken} ${invoices}, and billing restarts with the ${asDate(restartsWith)} invoice.` };
}
