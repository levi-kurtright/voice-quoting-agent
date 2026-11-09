// Summit Office Supply: shared Stripe helpers for the voice-agent endpoints.
import Stripe from "npm:stripe@^17";
export { Stripe };

export function getStripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2024-06-20" });
}

// Admin routes (demo setup, the simulated printer feed) require the ADMIN_TOKEN env var, sent as
// "Authorization: Bearer <token>". With no ADMIN_TOKEN set they stay closed. Comparing SHA-256 digests
// keeps the check's timing independent of how much of the token matched.
export async function isAdmin(req: Request): Promise<boolean> {
  const want = Deno.env.get("ADMIN_TOKEN") ?? "";
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !got) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(want), digest(got)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const cents = (n: number) => Math.round(Number(n) * 100);
export const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const asDate = (unix?: number | null) =>
  unix ? new Date(unix * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;

export const priceIdOf = (p: any) => (typeof p === "string" ? p : p?.id);
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function productFor(stripe: Stripe, name: string): Promise<string> {
  const s = slug(name);
  const found = await stripe.products.search({ query: `metadata['catalog_slug']:'${s}'`, limit: 1 }).catch(() => null);
  if (found?.data[0]) return found.data[0].id;
  const p = await stripe.products.create(
    { name, metadata: { catalog_slug: s, source: "summit_catalog" } },
    { idempotencyKey: `summit-product:${s}` },
  );
  return p.id;
}

export async function findInvoiceByNumber(stripe: Stripe, number: string): Promise<Stripe.Invoice | null> {
  try {
    const r = await stripe.invoices.search({ query: `number:"${number.replace(/"/g, "")}"`, limit: 1 });
    if (r.data[0]) return r.data[0];
  } catch (_e) { /* fall through */ }
  let starting_after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await stripe.invoices.list({ limit: 100, starting_after });
    const hit = list.data.find((i) => i.number === number);
    if (hit) return hit;
    if (!list.has_more) break;
    starting_after = list.data[list.data.length - 1]?.id;
  }
  return null;
}

export async function findCustomer(stripe: Stripe, dealer: any): Promise<Stripe.Customer | null> {
  if (dealer?.id) {
    const r = await stripe.customers.search({ query: `metadata['dealer_id']:'${dealer.id}'`, limit: 1 });
    if (r.data[0]) return r.data[0];
  }
  if (dealer?.email) {
    const r = await stripe.customers.list({ email: dealer.email, limit: 1 });
    if (r.data[0]) return r.data[0];
  }
  if (dealer?.name) {
    const r = await stripe.customers.search({ query: `name:'${String(dealer.name).replace(/'/g, "")}'`, limit: 1 });
    if (r.data[0]) return r.data[0];
  }
  return null;
}
