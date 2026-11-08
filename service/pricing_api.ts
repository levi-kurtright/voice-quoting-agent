// Summit Office Supply – demo pricing service for the Quinn voice quoting agent.
// All products, prices and policies are fictional demo data.
// Runs as an HTTP endpoint (for example, a Val Town HTTP val or a Cloudflare Worker).
//
// POST /quote  { "dealer_id": "D-1042", "lines": [{ "sku": "DESK-SIT", "qty": 50 }], "extra_discount_pct": 3 }
// GET  /catalog

type Product = { name: string; price: number; type: "one_time" | "monthly"; tiers: [number, number][] };

const CATALOG: Record<string, Product> = {
  "DESK-STD":    { name: "Standard desk",                 price: 289, type: "one_time", tiers: [[10, 5], [50, 10], [200, 15]] },
  "DESK-SIT":    { name: "Sit-stand desk",                price: 549, type: "one_time", tiers: [[10, 5], [50, 10], [200, 15]] },
  "CHAIR-ERG":   { name: "Ergonomic chair",               price: 219, type: "one_time", tiers: [[10, 5], [50, 10], [200, 15]] },
  "PRINTER-MFP": { name: "Multifunction printer",         price: 899, type: "one_time", tiers: [[5, 5], [20, 10]] },
  "PAPER-CASE":  { name: "Copy paper, case of 10 reams",  price: 42,  type: "one_time", tiers: [[50, 5], [100, 8], [500, 12]] },
  "TONER-SUB":   { name: "Toner subscription, per printer per month (12-month term)", price: 35, type: "monthly", tiers: [[10, 5], [50, 10]] },
  "INSTALL":     { name: "Delivery and installation, per desk", price: 45, type: "one_time", tiers: [] },
};

const MAX_AUTO_DISCOUNT = 5;        // extra discount (%) the agent can give without approval
const APPROVAL_THRESHOLD = 50000;   // one-time totals above this need manager approval
const FREE_DELIVERY_OVER = 2500;    // freight is free on one-time orders above this
const DELIVERY_FEE = 150;

const round = (n: number) => Math.round(n * 100) / 100;

function tierDiscount(p: Product, qty: number): number {
  let pct = 0;
  for (const [minQty, discount] of p.tiers) if (qty >= minQty) pct = discount;
  return pct;
}

function quote(body: any) {
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  const extra = Math.max(0, Number(body?.extra_discount_pct) || 0);
  const errors: string[] = [];
  const out: any[] = [];
  let oneTime = 0, monthly = 0;

  for (const l of lines) {
    const sku = String(l?.sku || "").toUpperCase();
    const qty = Math.floor(Number(l?.qty));
    const p = CATALOG[sku];
    if (!p) { errors.push(`Unknown product: ${sku || "(blank)"}`); continue; }
    if (!(qty > 0)) { errors.push(`Invalid quantity for ${sku}`); continue; }
    const volumePct = tierDiscount(p, qty);
    const totalPct = Math.min(volumePct + extra, 100);
    const unitNet = round(p.price * (1 - totalPct / 100));
    const lineNet = round(unitNet * qty);
    if (p.type === "monthly") monthly += lineNet; else oneTime += lineNet;
    out.push({ sku, product: p.name, qty, list_price: p.price, volume_discount_pct: volumePct,
               extra_discount_pct: extra, unit_net: unitNet, line_total: lineNet, billing: p.type });
  }

  const delivery = oneTime > 0 && oneTime <= FREE_DELIVERY_OVER ? DELIVERY_FEE : 0;
  oneTime = round(oneTime + delivery);
  monthly = round(monthly);

  const reasons: string[] = [];
  if (extra > MAX_AUTO_DISCOUNT) reasons.push(`Extra discount of ${extra}% is above the ${MAX_AUTO_DISCOUNT}% the agent can approve`);
  if (oneTime > APPROVAL_THRESHOLD) reasons.push(`One-time total is above $${APPROVAL_THRESHOLD.toLocaleString()}`);

  return {
    quote_id: "Q-" + Math.floor(100000 + Math.random() * 900000),
    dealer_id: body?.dealer_id || null,
    lines: out,
    delivery_fee: delivery,
    one_time_total: oneTime,
    monthly_recurring_total: monthly,
    annual_subscription_value: round(monthly * 12),
    approval_required: reasons.length > 0,
    approval_reasons: reasons,
    valid_days: 30,
    errors,
    note: "Prices exclude tax. Demo data only.",
  };
}

export default async function (req: Request): Promise<Response> {
  const url = new URL(req.url);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

  if (req.method === "GET" && url.pathname.endsWith("/catalog")) {
    return json(Object.entries(CATALOG).map(([sku, p]) => ({ sku, name: p.name, list_price: p.price, billing: p.type, volume_tiers: p.tiers })));
  }
  if (req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "Request body must be JSON" }, 400); }
    return json(quote(body));
  }
  return json({ service: "Summit Office Supply demo pricing", endpoints: ["GET /catalog", "POST /quote"] });
}
