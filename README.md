# Quinn: Voice Quoting Agent on Stripe Billing

A voice AI agent that takes a dealer's order over the phone, prices it exactly, and turns the "yes" into real billing objects in **Stripe**: a formal Quote, an invoice, and a subscription. Quinn also applies Stripe-validated promo codes, changes plans mid-term with Stripe proration, and right-sizes usage-based print plans from real meter data.

This repo also holds the **Stripe Billing service** shared with its sister agent, [Riley](https://github.com/levi-kurtright/elevenlabs-billing-voice-agent), who answers billing questions, issues credits within policy, and explains usage and failed payments.

Built for a fictional office products distributor, **Summit Office Supply**. All products, prices, dealers and policies are demo data. Stripe runs in **test mode**: real API calls and real objects, no real money.

## The design principle
**The agent never does math and never invents a number.** Language models handle the conversation. A deterministic pricing service owns every price, and **Stripe is the system of record** for quotes, invoices, subscriptions, credits and usage. Every amount Quinn or Riley says comes from a tool result built from Stripe's own fields.

## Architecture
```
Caller ──voice──▶ Quinn / Riley (ElevenLabs ElevenAgents)
                       │ webhook tools (JSON schemas in tools/)
                       ▼
        Pricing service (service/pricing_api.ts)         catalog, volume tiers, approval rules
        Stripe service  (service/stripe_endpoints.ts …)  Val Town HTTP val, TypeScript
                       │ Stripe API (test mode), idempotency keys on every write
                       ▼
        Stripe Billing: Quotes · Invoices · Subscriptions · Proration · Promotion codes
                        Credit notes · Billing meters · Subscription schedules · Test clocks
                       │
Caller ◀──voice── spoken_summary read back word for word
```

## What Quinn does
| Capability | Stripe feature | Guardrail |
|---|---|---|
| Exact quote by voice | Pricing service | Agent never calculates; reads results verbatim |
| Formal quote with number, expiry, PDF | Stripe Quotes | Accept only on a clear yes; never invents a quote number |
| Accept → invoice + subscription | Quote acceptance | Stripe generates the billing objects; retries are idempotent |
| Promo codes | Promotion codes + coupons | Only codes that exist and pass Stripe's rules (expiry, minimum order, first order only); one per quote; redemptions tracked |
| Add or remove units mid-term | Subscription update + proration | Preview first, caller hears the prorated amount, change bills exactly that |
| Print plan right-sizing | Billing meters + subscription schedules | Honest recommendation (including "stay on your plan"); switches start next period |
| Billing questions | Agent-to-agent transfer | Hands off to Riley in one step, no bounce-back |
| Anything it can't do | Tracked follow-up | Logs a ticket with a reference number before promising a callback |

## The Stripe service
| Module | Responsibility |
|---|---|
| [`service/stripe_endpoints.ts`](service/stripe_endpoints.ts) | Router; quotes, invoices, subscriptions, proration, promo codes, credit notes, status |
| [`service/core.ts`](service/core.ts) | Shared Stripe client and lookup helpers |
| [`service/print.ts`](service/print.ts) | Managed print plans on Stripe Billing meters, plan switches, test-clock demo |
| [`service/recovery.ts`](service/recovery.ts) | Failed card payments, Stripe retries, recovery demo |
| [`service/followups.ts`](service/followups.ts) | Tracked specialist follow-ups (Val Town SQLite) and the `GET /followups` queue |
| [`service/pricing_api.ts`](service/pricing_api.ts) | Deterministic pricing: catalog, volume tiers, delivery, approval rules |

The route map is at the top of [`stripe_endpoints.ts`](service/stripe_endpoints.ts).

### Run it yourself
1. Create a Val Town project with the files in `service/` (the HTTP entry point is `stripe_endpoints.ts`; `pricing_api.ts` is its own HTTP val).
2. Add an env var `STRIPE_SECRET_KEY` with a Stripe **test** key. Never hard-code it.
3. In ElevenLabs, create webhook tools from `tools/*.json`, replacing `YOUR-STRIPE-VAL` / `YOUR-PRICING-VAL` with your val URLs.
4. Use [`system_prompt.txt`](system_prompt.txt) as the agent's system prompt.
5. The admin routes (`/usage/setup`, `/usage/report`, `/demo/*`) create demo data in test mode. Gate or remove them before exposing the service publicly.

## Pricing rules (demo)
| Rule | Detail |
|---|---|
| Catalog | Standard desk, sit-stand desk, ergonomic chair, multifunction printer, copy paper (case), toner subscription (per printer per month, 12-month term), delivery and installation |
| Volume discounts | Tiered by quantity, for example desks and chairs: 5% at 10+, 10% at 50+, 15% at 200+ |
| Extra discount | Up to 5% on request; more needs manager approval |
| Approval | Extra discount over 5%, or one-time total over $50,000 |
| Managed print 5K | $49/month, 5,000 pages included, then 1.2¢ a page |
| Managed print 25K | $199/month, 25,000 pages included, then 0.9¢ a page (cheaper above ~17,500 pages) |

## Verified results (Stripe test mode)
- 50 desks + 50 chairs + install + toner → **$36,810 + $332.50/mo**, invoiced and paid on Stripe's hosted page
- Quote QT-G1O1OVID-0002-1 accepted by spoken number → Stripe generated the invoice and subscription
- "5 → 8 printers" → previewed **$99.69** prorated, confirmed change billed exactly **$99.69**; retry didn't double-charge
- "Toner fifteen" → TONER15 validated; accepted quote invoiced **$1,671.31** after **$294.94** off; Stripe recorded the redemption
- 50,700 pages projected → 25K plan saves ~$167/mo, switch scheduled for next period; ~15,000 pages → "stay on 5K"
- Test clock: when a switch took effect, Stripe billed the old period's 13,600 pages at 5K rates (**$103.20**) and started the new plan on a separate invoice

## Testing
11 automated ElevenLabs tests across both agents (simulated callers and tool-call checks), plus post-call scoring on every real call. Tools that write to Stripe are mocked in tests. See [`TESTS.md`](TESTS.md).

## Files
- [`system_prompt.txt`](system_prompt.txt): Quinn's prompt, exported from the live agent
- [`tools/`](tools): ElevenLabs webhook tool definitions
- [`service/`](service): pricing and Stripe services
- [`TESTS.md`](TESTS.md): test suite and call scoring

## Built with
ElevenLabs ElevenAgents · Stripe Billing (test mode) · TypeScript on Val Town · Claude Code
