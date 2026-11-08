// Summit Office Supply: tracked specialist follow-ups for the Quinn and Riley voice agents.
// Imported by stripe_endpoints.ts (Val Town HTTP val). Storage: Val Town SQLite.

/* ------------------------------------------------------- Both agents: tracked specialist follow-ups */
//
// Every "a specialist will follow up" becomes a ticket with a reference number, so nothing promised on a
// call gets lost. Stored in Val Town SQLite; GET /followups renders the open queue.

const FOLLOWUP_REASONS = ["cancellation", "credit_over_limit", "dispute", "high_value", "upset_caller", "plan_change_exception", "payment_problem", "other"];

async function followupDb() {
  const { sqlite } = await import("https://esm.town/v/std/sqlite");
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, dealer_id TEXT, dealer_name TEXT, agent TEXT, reason TEXT,
    amount REAL, invoice_number TEXT, summary TEXT, conversation_id TEXT, status TEXT)`);
  return sqlite;
}
const rowsOf = (r: any): any[] => (r?.rows ?? []).map((row: any) =>
  Array.isArray(row) ? Object.fromEntries((r.columns ?? []).map((c: string, i: number) => [c, row[i]])) : row);
const refOf = (id: number) => `FU-${1000 + Number(id)}`;

// POST /followup { dealer, agent, reason, summary, amount?, invoice_number?, conversation_id? }
// resolveDealer looks the dealer up in Stripe (injected by the router to keep this module dependency-free).
export async function logFollowUp(body: any, resolveDealer: (d: any) => Promise<{ id?: string; name?: string } | null>) {
  const reason = FOLLOWUP_REASONS.includes(String(body?.reason)) ? String(body.reason) : "other";
  const summary = String(body?.summary ?? "").trim().slice(0, 600);
  if (!summary) return { ok: true, logged: false, spoken_summary: `What should I tell the specialist this is about?` };
  let dealerId = String(body?.dealer?.id ?? ""), dealerName = String(body?.dealer?.name ?? "");
  try {
    const c = body?.dealer ? await resolveDealer(body.dealer) : null;
    if (c) { dealerId = c.id || dealerId; dealerName = c.name || dealerName; }
  } catch (_e) { /* log with what the caller gave */ }

  const db = await followupDb();
  // Same dealer, same reason, still open, within 30 minutes: a repeat of the same request, not a new ticket.
  const dup = rowsOf(await db.execute({
    sql: `SELECT id FROM followups WHERE dealer_id = ? AND reason = ? AND status = 'open' AND created_at > ? ORDER BY id DESC LIMIT 1`,
    args: [dealerId, reason, new Date(Date.now() - 30 * 60 * 1000).toISOString()],
  }));
  if (dup[0]) return { ok: true, logged: true, already_logged: true, reference: refOf(dup[0].id),
    spoken_summary: `That's already logged for a specialist under reference ${refOf(dup[0].id)}. They'll follow up with you.` };

  await db.execute({
    sql: `INSERT INTO followups (created_at, dealer_id, dealer_name, agent, reason, amount, invoice_number, summary, conversation_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    args: [new Date().toISOString(), dealerId, dealerName, String(body?.agent ?? ""), reason,
      body?.amount != null && body.amount !== "" ? Number(body.amount) : null, String(body?.invoice_number ?? ""), summary, String(body?.conversation_id ?? "")],
  });
  const last = rowsOf(await db.execute(`SELECT MAX(id) AS id FROM followups`))[0];
  const ref = refOf(last.id);
  return { ok: true, logged: true, reference: ref,
    spoken_summary: `I've logged this for a billing specialist, and they'll follow up with you. Your reference number is ${ref}.` };
}

// GET /followups  -> the open follow-up queue as a simple page
export async function followupsPage(): Promise<Response> {
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  let rows: any[] = [];
  try { rows = rowsOf(await (await followupDb()).execute(`SELECT * FROM followups ORDER BY id DESC LIMIT 200`)); } catch (_e) { /* empty queue */ }
  const tr = rows.map((r) => `<tr><td>${esc(refOf(r.id))}</td><td>${esc(new Date(r.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" }))}</td><td>${esc(r.dealer_id)}<br><small>${esc(r.dealer_name)}</small></td><td>${esc(r.agent)}</td><td>${esc(r.reason.replace(/_/g, " "))}</td><td>${r.amount == null ? "" : "$" + Number(r.amount).toFixed(2)}</td><td>${esc(r.invoice_number)}</td><td>${esc(r.summary)}</td><td>${esc(r.status)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Specialist follow-ups</title>
<style>body{font:15px/1.45 system-ui,sans-serif;margin:0;padding:24px 16px;background:#f7f7f5;color:#1d1d1b}h1{font-size:1.4rem;margin:0 0 4px}p{color:#666;margin:0 0 18px}
.wrap{overflow-x:auto;background:#fff;border:1px solid #e3e3df;border-radius:12px}table{border-collapse:collapse;width:100%;min-width:860px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:#777}small{color:#888}
@media(prefers-color-scheme:dark){body{background:#151513;color:#eee}.wrap{background:#1e1e1b;border-color:#333}th,td{border-color:#2c2c28}p,small,th{color:#aaa}}</style></head>
<body><h1>Specialist follow-ups</h1><p>Logged by Quinn and Riley whenever a call needs a person. Summit Office Supply demo, synthetic data.</p>
<div class="wrap"><table><thead><tr><th>Ref</th><th>Logged (CT)</th><th>Dealer</th><th>Agent</th><th>Reason</th><th>Amount</th><th>Invoice</th><th>Summary</th><th>Status</th></tr></thead>
<tbody>${tr || `<tr><td colspan="9">No follow-ups yet.</td></tr>`}</tbody></table></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
