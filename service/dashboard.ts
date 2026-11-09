// Summit Office Supply: GET /dashboard, a live revenue view built from Stripe plus the agents' call logs.
// Every number is read from Stripe (test mode) on each page load; follow-ups and activity come from Val Town SQLite.
import { Stripe, getStripe, money, priceIdOf } from "./core.ts";
import { followupCounts, invoicesWithActivity, recentActivity } from "./followups.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function allPages<T>(fetchPage: (after?: string) => Promise<Stripe.ApiList<T & { id: string }>>, max = 3): Promise<(T & { id: string })[]> {
  const out: (T & { id: string })[] = [];
  let after: string | undefined;
  for (let i = 0; i < max; i++) {
    const page = await fetchPage(after);
    out.push(...page.data);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1]?.id;
  }
  return out;
}

export async function dashboardPage(): Promise<Response> {
  const stripe = getStripe();
  // Test-clock customers are excluded from default lists, so read them per clock.
  const clocks = (await stripe.testHelpers.testClocks.list({ limit: 20 })).data;
  const clockCustomers = (await Promise.all(clocks.map((c) => stripe.customers.list({ test_clock: c.id, limit: 20 } as any)))).flatMap((l) => l.data);

  const [subsMain, invMain, quotes, creditNotes, promos, grants] = await Promise.all([
    allPages<Stripe.Subscription>((a) => stripe.subscriptions.list({ status: "all", limit: 100, starting_after: a })),
    allPages<Stripe.Invoice>((a) => stripe.invoices.list({ limit: 100, starting_after: a })),
    allPages<Stripe.Quote>((a) => stripe.quotes.list({ limit: 100, starting_after: a })),
    allPages<Stripe.CreditNote>((a) => stripe.creditNotes.list({ limit: 100, starting_after: a })),
    stripe.promotionCodes.list({ limit: 100 }),
    (stripe as any).billing.creditGrants.list({ limit: 100 }, { apiVersion: "2024-10-28.acacia" }).catch(() => ({ data: [] })),
  ]);
  const clockSubs = (await Promise.all(clockCustomers.map((c) => stripe.subscriptions.list({ customer: c.id, status: "all", limit: 20 })))).flatMap((l) => l.data);
  const clockInv = (await Promise.all(clockCustomers.map((c) => stripe.invoices.list({ customer: c.id, limit: 50 })))).flatMap((l) => l.data);
  const subs = [...new Map([...subsMain, ...clockSubs].map((s) => [s.id, s])).values()];
  const invoices = [...new Map([...invMain, ...clockInv].map((i) => [i.id, i])).values()];

  // Recurring revenue: licensed monthly items on live subscriptions (metered page charges are usage, shown separately).
  const live = subs.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
  const mrr = live.reduce((sum, s) => sum + s.items.data.reduce((t, it) =>
    t + (it.price.recurring?.usage_type !== "metered" && it.price.recurring?.interval === "month" ? (it.price.unit_amount ?? 0) * (it.quantity ?? 1) : 0), 0), 0);
  const metered = live.filter((s) => s.items.data.some((it) => it.price.recurring?.usage_type === "metered")).length;

  const open = invoices.filter((i) => i.status === "open");
  const ar = open.reduce((s, i) => s + i.amount_remaining, 0);
  const failing = open.filter((i) => i.collection_method === "charge_automatically" && i.attempt_count > 0);
  const everFailed = await invoicesWithActivity("payment_failed");
  const recovered = invoices.filter((i) => i.status === "paid" && i.collection_method === "charge_automatically" && (i.attempt_count > 1 || everFailed.has(i.number ?? "")));
  const collected = invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount_paid, 0);
  const taxCollected = invoices.filter((i) => i.status === "paid" || i.status === "open").reduce((s, i) => s + ((i as any).tax ?? 0), 0);

  const qBy = (st: string) => quotes.filter((q) => q.status === st);
  const accepted = qBy("accepted");
  const acceptedValue = accepted.reduce((s, q) => s + (q.amount_total ?? 0), 0);
  const aiQuotes = quotes.filter((q) => q.metadata?.source === "ai_buyer_mcp");

  const cnTotal = creditNotes.filter((c) => c.status !== "void").reduce((s, c) => s + c.amount, 0);
  const redemptions = promos.data.reduce((s, p) => s + p.times_redeemed, 0);
  const granted = (grants.data ?? []).filter((g: any) => !g.voided_at).reduce((s: number, g: any) => s + (g.amount?.monetary?.value ?? 0), 0);

  const fu = await followupCounts();
  const activity = await recentActivity(20);
  const nameOf = new Map<string, string>();
  for (const c of clockCustomers) nameOf.set(c.id, c.name ?? "");

  const tile = (label: string, value: string, sub = "") => `<div class="tile"><div class="lbl">${esc(label)}</div><div class="val">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const actLabel: Record<string, string> = { payment_failed: "Card payment failed", payment_recovered: "Payment recovered", invoice_paid: "Invoice paid",
    payment_link_sent: "Payment link sent (Riley)", credit_topup_invoiced: "Print credit sold (Quinn)", credit_topup_paid: "Print credit paid, granted", payment_retry_succeeded: "Card retried and paid (Riley)",
    ai_quote_created: "Quote requested by an AI buyer (MCP)" };

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Summit revenue dashboard</title>
<style>:root{--bg:#f6f6f3;--card:#fff;--ink:#1c1c1a;--mute:#6b6b66;--line:#e4e4de;--accent:#635bff;--good:#0f7b4f;--bad:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#141412;--card:#1d1d1a;--ink:#ececE8;--mute:#a3a39c;--line:#2e2e2a;--accent:#8f88ff;--good:#4cc38a;--bad:#ff7a6b}}
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px 40px;background:var(--bg);color:var(--ink)}
main{max-width:1100px;margin:0 auto}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1rem;margin:28px 0 10px}p.note{color:var(--mute);margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.lbl{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.val{font-size:1.6rem;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}.sub{color:var(--mute);font-size:.85rem;margin-top:2px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
td.num{font-variant-numeric:tabular-nums;text-align:right}.bad{color:var(--bad)}.good{color:var(--good)}a{color:var(--accent)}</style></head>
<body><main><h1>Summit Office Supply revenue</h1>
<p class="note">Live from Stripe (test mode) on every load, plus the Quinn and Riley call logs. Synthetic demo data. <a href="followups">Follow-up queue</a></p>
<h2>Recurring revenue</h2><div class="grid">
${tile("Monthly recurring revenue", money(mrr), `${live.length} live subscriptions`)}
${tile("Usage-billed plans", String(metered), "managed print, metered pages")}
${tile("Prepaid print credit granted", money(granted), "Stripe Billing credits")}
</div>
<h2>Quote to cash (Quinn and AI buyers)</h2><div class="grid">
${tile("Quotes accepted", String(accepted.length), `${money(acceptedValue)} first-invoice value`)}
${tile("Open quotes", String(qBy("open").length), "waiting on the dealer's yes")}
${tile("Quotes from AI buyers", String(aiQuotes.length), `${aiQuotes.filter((q) => q.status === "accepted").length} accepted by a person (MCP)`)}
${tile("Promo redemptions", String(redemptions), "Stripe-validated codes")}
${tile("Collected", money(collected), "paid invoices")}
</div>
<h2>Collections and service (Riley)</h2><div class="grid">
${tile("Open receivables", money(ar), `${open.length} open invoices`)}
${tile("Failed card payments", String(failing.length), failing.length ? money(failing.reduce((s, i) => s + i.amount_remaining, 0)) + " at risk" : "none right now")}
${tile("Recovered payments", String(recovered.length), money(recovered.reduce((s, i) => s + i.amount_paid, 0)) + " paid after a retry")}
${tile("Credits issued by phone", money(cnTotal), `${creditNotes.length} credit notes`)}
${tile("Open follow-ups", String(fu.open), `${fu.resolved} resolved`)}
${tile("Sales tax on invoices", money(taxCollected), "Stripe Tax")}
</div>
<h2>Failed card payments</h2><div class="wrap"><table><thead><tr><th>Dealer</th><th>Invoice</th><th>Attempts</th><th>Next Stripe retry</th><th style="text-align:right">Amount</th></tr></thead><tbody>
${failing.map((i) => `<tr><td>${esc(i.customer_name ?? nameOf.get(priceIdOf(i.customer)) ?? "")}</td><td>${esc(i.number)}</td><td>${i.attempt_count}</td><td>${i.next_payment_attempt ? esc(new Date(i.next_payment_attempt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })) : "none"}</td><td class="num bad">${money(i.amount_remaining)}</td></tr>`).join("") || `<tr><td colspan="5">No failed payments right now.</td></tr>`}
</tbody></table></div>
<h2>Recent Stripe activity</h2><div class="wrap"><table><thead><tr><th>When (CT)</th><th>Event</th><th>Dealer</th><th>Invoice</th><th style="text-align:right">Amount</th><th>Detail</th></tr></thead><tbody>
${activity.map((a) => `<tr><td>${esc(when(a.created_at))}</td><td class="${a.type === "payment_failed" ? "bad" : a.type === "payment_recovered" ? "good" : ""}">${esc(actLabel[a.type] ?? a.type)}</td><td>${esc(a.dealer_id)} <span style="color:var(--mute)">${esc(a.dealer_name)}</span></td><td>${esc(a.invoice_number)}</td><td class="num">${a.amount == null ? "" : money(Math.round(Number(a.amount) * 100))}</td><td>${esc(a.detail)}</td></tr>`).join("") || `<tr><td colspan="6">No webhook activity recorded yet.</td></tr>`}
</tbody></table></div>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
