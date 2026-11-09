// Summit Office Supply: MCP server so AI purchasing agents can price orders and get formal Stripe quotes.
//
// POST /mcp   Model Context Protocol over Streamable HTTP (JSON-RPC, plain JSON responses, stateless).
//             Connect it as a remote MCP server in Claude, ChatGPT, or any MCP client.
//
// Same rules as Quinn on the phone:
//   - Every price comes from the pricing service, recomputed here from SKUs and quantities. A buyer agent
//     can never send its own prices.
//   - Formal quotes are created by Stripe (Stripe Tax, validated promo codes, 30-day expiry, PDF).
//   - Discounts above Summit's limit and very large orders go to a manager as a tracked follow-up.
//   - An AI can't accept a quote or place an order. A person at the dealer accepts it, by phone with Quinn
//     or through their Summit rep, and Stripe then creates the invoice and subscription.
//   - Only existing dealer accounts, a cap of 10 AI quotes per dealer per day, and every quote is logged.
//
// Optional env var MCP_BUYER_KEYS = {"<random key>": "D-1042", ...}. When set, every call needs
// "Authorization: Bearer <key>" and can only act for that key's dealer. Without it, the endpoint has the same
// trust as the phone line: a dealer number identifies the account, and nothing binding happens without a person.

import pricing from "https://esm.town/v/levikurtright/summit-pricing/main.ts"; // the pricing val (pricing_api.ts in this repo)
import { Stripe, asDate, findCustomer, getStripe, money } from "./core.ts";
import { logActivity, logFollowUp } from "./followups.ts";

type Deps = { createQuote: (body: any) => Promise<any>; checkPromo: (body: any) => Promise<any>; origin: string };
type Priced = { lines: any[]; delivery_fee: number; one_time_total: number; monthly_recurring_total: number;
  annual_subscription_value: number; approval_required: boolean; approval_reasons: string[]; errors: string[] };

const SERVER = { name: "summit-office-supply", title: "Summit Office Supply quoting", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DAILY_QUOTE_LIMIT = 10;
const HOW_TO_ACCEPT = "This quote is not an order. AI agents can't accept quotes: a person at the dealer accepts it by calling "
  + "Summit Office Supply and giving the quote number, or through their Summit rep. Stripe then creates the invoice.";

const INSTRUCTIONS = `Summit Office Supply (a fictional distributor; Stripe test mode, no real money). Tools for AI purchasing agents:
get_catalog lists products, list prices and volume discounts. price_order prices an order exactly (read-only).
request_quote creates a formal Stripe quote with sales tax for an existing dealer. get_quote_status checks a quote.
Never calculate prices yourself; use price_order. Prices are set by Summit's rules: an extra discount request above
Summit's limit, or a very large order, goes to a Summit manager instead of producing a quote. A quote is not an order,
and only a person at the dealer can accept it. Tell your user the quote number, totals and how to accept.`;

/* ------------------------------------------------------------------------------------- tools */

const linesSchema = {
  type: "array", minItems: 1, maxItems: 20, description: "Products and quantities",
  items: { type: "object", additionalProperties: false, required: ["sku", "qty"], properties: {
    sku: { type: "string", description: "Product SKU from get_catalog, for example DESK-SIT" },
    qty: { type: "integer", minimum: 1, maximum: 10000, description: "Quantity. For TONER-SUB, the number of printers." },
  } },
};
const dealerSchema = { type: "string", description: "The buyer's Summit dealer number, for example D-1042" };

const TOOLS = [
  { name: "get_catalog", title: "Get catalog",
    description: "List Summit's products with SKUs, list prices, billing (one-time or monthly) and volume discount tiers. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "price_order", title: "Price an order",
    description: "Price an order exactly with Summit's pricing rules: volume discounts, delivery, and whether a manager must approve. "
      + "Optionally checks a promo code against Stripe. Read-only: creates nothing. Prices exclude sales tax; request_quote adds it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["dealer_id", "lines"], properties: {
      dealer_id: dealerSchema, lines: linesSchema,
      extra_discount_pct: { type: "number", minimum: 0, maximum: 100, description: "Extra discount the buyer is asking for, beyond volume discounts. Omit or 0 if none." },
      promo_code: { type: "string", description: "A promo code to validate, if the buyer has one" },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "request_quote", title: "Request a formal quote",
    description: "Create a formal Stripe quote for an existing dealer: quote number, sales tax from Stripe Tax, 30-day expiry and a PDF. "
      + "Prices are recomputed from the SKUs and quantities. If the order needs manager approval, no quote is created and a manager follow-up is logged instead. "
      + "Repeating the same request on the same day returns the same quote. The quote is not an order: only a person at the dealer can accept it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["dealer_id", "lines"], properties: {
      dealer_id: dealerSchema, lines: linesSchema,
      extra_discount_pct: { type: "number", minimum: 0, maximum: 100, description: "Extra discount requested, beyond volume discounts. Omit or 0 if none." },
      promo_code: { type: "string", description: "A promo code to apply, if price_order said it is valid" },
      ship_to_zip: { type: "string", description: "5-digit US ZIP code the order ships to, used by Stripe Tax. Needed if the dealer has no ZIP on file." },
      buyer_reference: { type: "string", maxLength: 100, description: "The buyer's own reference, such as a purchase request number" },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_quote_status", title: "Get quote status",
    description: "Look up one of the dealer's Stripe quotes by quote number: status (open, accepted, canceled), totals, expiry, PDF link, and the invoice once accepted. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["dealer_id", "quote_number"], properties: {
      dealer_id: dealerSchema, quote_number: { type: "string", description: "Quote number, for example QT-G1O1OVID-0002-1" },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
];

class ToolError extends Error {}

async function priceLines(lines: any[], extra: number): Promise<Priced> {
  const r = await pricing(new Request("https://pricing.internal/quote", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines: lines.map((l) => ({ sku: String(l?.sku ?? ""), qty: Math.floor(Number(l?.qty)) })), extra_discount_pct: extra }) }));
  return await r.json();
}

function readLines(args: any): any[] {
  const lines = Array.isArray(args?.lines) ? args.lines : [];
  if (!lines.length || lines.length > 20) throw new ToolError("lines must list 1 to 20 products, each with sku and qty.");
  for (const l of lines) {
    const q = Number(l?.qty);
    if (!l?.sku || !Number.isInteger(q) || q < 1 || q > 10000) throw new ToolError("Each line needs a sku from get_catalog and a whole-number qty from 1 to 10,000.");
  }
  return lines;
}
const readExtra = (args: any) => {
  const x = Number(args?.extra_discount_pct ?? 0);
  if (!Number.isFinite(x) || x < 0 || x > 100) throw new ToolError("extra_discount_pct must be between 0 and 100.");
  return x;
};

async function dealerAccount(stripe: Stripe, args: any, authDealer: string | null): Promise<Stripe.Customer> {
  const id = String(args?.dealer_id ?? "").trim().toUpperCase();
  if (!/^D-\d{3,6}$/.test(id)) throw new ToolError("dealer_id must be a Summit dealer number like D-1042.");
  if (authDealer && authDealer !== id) throw new ToolError(`This connection is authorized for dealer ${authDealer} only.`);
  const c = await findCustomer(stripe, { id });
  if (!c) throw new ToolError(`No Summit account for dealer ${id}. New accounts are set up by Summit's team, not through this connection.`);
  return c;
}

function pricedView(p: Priced) {
  return {
    lines: p.lines.map((l) => ({ sku: l.sku, product: l.product, qty: l.qty, list_price: l.list_price, volume_discount_pct: l.volume_discount_pct,
      extra_discount_pct: l.extra_discount_pct, unit_net: l.unit_net, line_total: l.line_total, billing: l.billing })),
    delivery_fee: p.delivery_fee, one_time_total: p.one_time_total, monthly_recurring_total: p.monthly_recurring_total,
    annual_subscription_value: p.annual_subscription_value, approval_required: p.approval_required, approval_reasons: p.approval_reasons,
    currency: "usd", prices_exclude_tax: true,
  };
}

async function getCatalog() {
  const r = await pricing(new Request("https://pricing.internal/catalog"));
  const items: any[] = await r.json();
  return {
    products: items.map((p) => ({ sku: p.sku, name: p.name, list_price: p.list_price, billing: p.billing,
      volume_discounts: (p.volume_tiers ?? []).map(([min_qty, pct]: [number, number]) => ({ min_qty, pct })) })),
    currency: "usd",
    notes: "List prices exclude sales tax. Use price_order for exact net prices, delivery and approval rules. "
      + "TONER-SUB is billed monthly per printer on a 12-month term; everything else is one-time.",
  };
}

async function priceOrder(args: any, deps: Deps, authDealer: string | null) {
  const stripe = getStripe();
  const lines = readLines(args), extra = readExtra(args);
  const customer = await dealerAccount(stripe, args, authDealer);
  const p = await priceLines(lines, extra);
  if (p.errors?.length) throw new ToolError(p.errors.join("; ") + ". Use SKUs from get_catalog.");
  let promo: any = null;
  if (args?.promo_code) {
    const c = await deps.checkPromo({ code: args.promo_code, dealer: { id: customer.metadata?.dealer_id }, lines: p.lines });
    promo = { code: c.code, valid: !!c.valid, ...(c.valid ? { description: c.description } : { reason: c.spoken_summary }) };
  }
  return { dealer_id: customer.metadata?.dealer_id, dealer_name: customer.name, ...pricedView(p), promo,
    next_step: p.approval_required
      ? "This order needs a Summit manager's approval. request_quote will log it for a manager instead of creating a quote."
      : "Call request_quote with the same lines to get a formal Stripe quote with sales tax." };
}

// Same dealer, same quoted lines and prices, same promo and ZIP, same day -> same reference -> the same Stripe quote.
async function referenceFor(dealerId: string, lines: any[], extra: number, promo: string, zip: string): Promise<string> {
  const norm = lines.map((l) => `${l.product}|${l.qty}|${l.unit_net}|${l.billing}`).sort().join(",");
  const day = new Date().toISOString().slice(0, 10);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${dealerId}|${norm}|${extra}|${promo}|${zip}|${day}`)));
  return "AIQ-" + [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function requestQuote(args: any, deps: Deps, authDealer: string | null) {
  const stripe = getStripe();
  const lines = readLines(args), extra = readExtra(args);
  const customer = await dealerAccount(stripe, args, authDealer);
  const dealerId = String(customer.metadata?.dealer_id ?? "");
  const zip = String(args?.ship_to_zip ?? "").replace(/[^0-9]/g, "").slice(0, 5);
  const promo = String(args?.promo_code ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");

  const p = await priceLines(lines, extra);
  if (p.errors?.length) throw new ToolError(p.errors.join("; ") + ". Use SKUs from get_catalog.");

  if (p.approval_required) {
    const items = p.lines.map((l) => `${l.qty} x ${l.sku}`).join(", ");
    const fu = await logFollowUp({ dealer: { id: dealerId }, agent: "ai_buyer_mcp", reason: "high_value", amount: p.one_time_total,
      summary: `AI purchasing agent requested a quote that needs manager approval: ${items}; extra discount ${extra}%. ${p.approval_reasons.join("; ")}.` },
      async () => ({ id: dealerId, name: customer.name ?? undefined }));
    return { created: false, approval_required: true, approval_reasons: p.approval_reasons, followup_reference: fu.reference ?? null, ...pricedView(p),
      message: `No quote was created. ${p.approval_reasons.join("; ")}, so a Summit manager will review it and follow up with the dealer`
        + (fu.reference ? ` (reference ${fu.reference}).` : ".") };
  }

  // The quote carries exactly what price_order showed, including delivery on small orders.
  const quoteLines = [...p.lines, ...(p.delivery_fee > 0 ? [{ product: "Delivery", qty: 1, unit_net: p.delivery_fee, billing: "one_time" }] : [])];
  const recent = await stripe.quotes.list({ customer: customer.id, limit: 100 });
  const reference = await referenceFor(dealerId, quoteLines, extra, promo, zip);
  const isRepeat = recent.data.some((q) => q.metadata?.quote_id === reference);
  const today = recent.data.filter((q) => q.metadata?.source === "ai_buyer_mcp" && q.created * 1000 > Date.now() - 86400_000);
  if (!isRepeat && new Set(today.map((q) => q.metadata?.quote_id)).size >= DAILY_QUOTE_LIMIT)
    throw new ToolError(`Dealer ${dealerId} has reached ${DAILY_QUOTE_LIMIT} AI-requested quotes in the last 24 hours. Please contact Summit directly.`);

  const r = await deps.createQuote({ quote_id: reference, channel: "ai_buyer", buyer_reference: args?.buyer_reference,
    dealer: { id: dealerId, ...(zip ? { postal_code: zip } : {}) }, lines: quoteLines, promo_code: promo });
  if (r.needs_postal_code) return { created: false, needs_ship_to_zip: true,
    message: zip ? `Stripe Tax couldn't validate ZIP code ${zip}. Ask the buyer for the ship-to ZIP code and call request_quote again.`
      : "Sales tax needs the ship-to location. Ask the buyer for the 5-digit ship-to ZIP code and call request_quote again with ship_to_zip." };
  if (r.promo_applied === false && !r.quote_number) return { created: false, promo_code: promo, message: String(r.spoken_summary ?? "The promo code was not applied.") };

  const total = r.tax_enabled ? `${money(Math.round(r.first_invoice_total * 100))} on the first invoice including ${money(Math.round(r.tax_first_invoice * 100))} sales tax`
    : `${money(Math.round(r.first_invoice_total * 100))} on the first invoice`;
  const monthly = r.monthly_total ? `, then ${money(Math.round(r.monthly_total * 100))} a month${r.tax_enabled ? " including tax" : ""}` : "";
  if (!r.already_quoted) await logActivity({ event_id: `mcp:${r.stripe_quote_id}`, type: "ai_quote_created", dealer_id: dealerId, dealer_name: customer.name ?? "",
    amount: r.first_invoice_total, detail: `Quote ${r.quote_number} requested by an AI purchasing agent over MCP${args?.buyer_reference ? ` (buyer ref ${String(args.buyer_reference).slice(0, 60)})` : ""}` }).catch(() => {});
  return {
    created: !r.already_quoted, already_quoted: !!r.already_quoted, quote_number: r.quote_number, status: r.status, valid_until: r.valid_until,
    dealer_id: dealerId, dealer_name: customer.name, ...pricedView(p),
    stripe_totals: { one_time_before_tax: r.one_time_before_tax, monthly_before_tax: r.monthly_before_tax, tax_first_invoice: r.tax_first_invoice,
      tax_monthly: r.tax_monthly, first_invoice_total: r.first_invoice_total, first_invoice_discount: r.first_invoice_discount, monthly_total: r.monthly_total },
    promo_code: r.promo_code, quote_pdf_url: r.quote_pdf_url, how_to_accept: HOW_TO_ACCEPT,
    message: `${r.already_quoted ? "This order already has" : "Created"} Stripe quote ${r.quote_number}: ${total}${monthly}. Valid until ${r.valid_until}. ${HOW_TO_ACCEPT}`,
  };
}

async function quoteStatus(args: any, deps: Deps, authDealer: string | null) {
  const stripe = getStripe();
  const customer = await dealerAccount(stripe, args, authDealer);
  const norm = (s: string) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const want = norm(args?.quote_number);
  if (!want) throw new ToolError("quote_number is required.");
  const list = await stripe.quotes.list({ customer: customer.id, limit: 100 });
  const q = list.data.find((x) => x.number && norm(x.number) === want)
    ?? list.data.find((x) => x.number && norm(x.number).startsWith(want) && norm(x.number).length - want.length <= 2);
  if (!q) throw new ToolError(`No quote ${args?.quote_number} on dealer ${customer.metadata?.dealer_id}'s account.`);
  const expired = q.status === "open" && !!q.expires_at && q.expires_at * 1000 < Date.now();
  let invoice: Stripe.Invoice | null = null;
  if (q.status === "accepted") {
    const invId = q.invoice ?? (q.subscription ? (await stripe.subscriptions.retrieve(String(q.subscription))).latest_invoice : null);
    if (invId) invoice = await stripe.invoices.retrieve(String(typeof invId === "string" ? invId : (invId as any).id));
  }
  return {
    quote_number: q.number, status: expired ? "expired" : q.status, valid_until: asDate(q.expires_at),
    first_invoice_total: (q.computed?.upfront?.amount_total ?? q.amount_total ?? 0) / 100,
    monthly_total: (q.computed?.recurring?.amount_total ?? 0) / 100,
    requested_by_ai: q.metadata?.source === "ai_buyer_mcp",
    quote_pdf_url: deps.origin ? `${deps.origin}/quote-pdf/${q.id}` : null,
    invoice: invoice ? { number: invoice.number, status: invoice.status, total: invoice.total / 100, amount_due: invoice.amount_remaining / 100, due_date: asDate(invoice.due_date) } : null,
    ...(q.status === "open" && !expired ? { how_to_accept: HOW_TO_ACCEPT } : {}),
  };
}

/* ----------------------------------------------------------------------------- buyer keys */

async function buyerAuth(req: Request): Promise<{ ok: boolean; dealer: string | null }> {
  const raw = Deno.env.get("MCP_BUYER_KEYS");
  if (!raw) return { ok: true, dealer: null };
  let keys: Record<string, string> = {};
  try { keys = JSON.parse(raw); } catch (_e) { return { ok: false, dealer: null }; }
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!got) return { ok: false, dealer: null };
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const g = await digest(got);
  for (const [k, dealer] of Object.entries(keys)) {
    const d = await digest(k);
    let diff = 0;
    for (let i = 0; i < d.length; i++) diff |= d[i] ^ g[i];
    if (diff === 0) return { ok: true, dealer: String(dealer).toUpperCase() };
  }
  return { ok: false, dealer: null };
}

/* ---------------------------------------------------------------------------- JSON-RPC */

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id" };
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export async function handleMcp(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "Summit MCP endpoint: POST JSON-RPC messages here (Streamable HTTP, JSON responses, no SSE stream)." }),
      { status: 405, headers: { ...CORS, allow: "POST, OPTIONS", "content-type": "application/json" } });
  const auth = await buyerAuth(req);
  if (!auth.ok) return out({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <buyer key>" } }, 401);
  let msg: any;
  try { msg = await req.json(); } catch (_e) { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }

  const handle = async (m: any): Promise<any | null> => {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string")
      return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    if (m.id === undefined || m.id === null) return null; // notification (e.g. notifications/initialized): no response
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": {
        const name = String(m.params?.name ?? ""), args = m.params?.arguments ?? {};
        const fn = { get_catalog: getCatalog, price_order: priceOrder, request_quote: requestQuote, get_quote_status: quoteStatus }[name];
        if (!fn) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        try {
          const result = await (fn as any)(args, deps, auth.dealer);
          return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          const text = e instanceof ToolError ? e.message : `Summit's service hit an error: ${String((e as Error)?.message ?? e)}`;
          return ok({ content: [{ type: "text", text }], isError: true });
        }
      }
      default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };

  if (Array.isArray(msg)) {
    const replies = (await Promise.all(msg.map(handle))).filter(Boolean);
    return replies.length ? out(replies) : new Response(null, { status: 202, headers: CORS });
  }
  const reply = await handle(msg);
  return reply ? out(reply) : new Response(null, { status: 202, headers: CORS });
}
