# Quinn: Voice Quoting Agent (ElevenLabs + live pricing service)

A voice AI agent that takes a dealer's order over the phone, prices it through a live pricing service, and reads back an accurate quote in seconds. Quinn applies volume discounts, splits one-time from subscription charges, and routes large orders or big discount requests to manager approval.

Built for a fictional office products distributor, **Summit Office Supply**. All products, prices and policies are demo data.

## Why this matters
Quoting is where revenue starts, and where it often leaks. Prices get calculated by hand, discounts drift, and approvals get skipped. Quinn shows how a voice agent can take an order naturally while a separate pricing service keeps every number exact. It's the same split between conversation and pricing logic that CPQ and quote-to-cash systems rely on.

## How it works
```
Caller ──voice──▶ Quinn (ElevenLabs ElevenAgents)
                     │  confirms items and quantities
                     │  calls the calculate_quote tool
                     ▼
              Pricing service (pricing_api.ts, hosted on Val Town)
                     │  catalog, volume tiers, delivery, approval rules
                     ▼
              Quote: lines, one-time total, monthly total, quote number, approval flag
                     │
Caller ◀──voice── Quinn reads back the totals and next steps
```

**Design principle: the agent never does math.** Language models can make arithmetic mistakes, and quotes have to be exact. Quinn handles the conversation; the pricing service handles every number.

## Pricing rules (demo)
| Rule | Detail |
|---|---|
| Catalog | Standard desk, sit-stand desk, ergonomic chair, multifunction printer, copy paper (case), toner subscription (per printer per month, 12-month term), delivery and installation (per desk) |
| Volume discounts | Tiered by quantity on each line, for example desks and chairs: 5% at 10+, 10% at 50+, 15% at 200+ |
| Recurring vs. one-time | Toner subscriptions are quoted as a monthly amount and annual value, separate from the one-time total |
| Delivery | Free on one-time orders over $2,500; otherwise $150 |
| Extra discount | Quinn can add up to 5% on request |
| Approval | Extra discount over 5%, or one-time total over $50,000, requires manager approval |

## Test scenarios (all passed in live voice testing)
1. **Standard order:** 50 sit-stand desks, 50 chairs, installation and toner for 10 printers → $36,810 one-time + $332.50/month, with 10% and 5% volume discounts applied
2. **Discount push:** caller asks for 10% off → Quinn explains it needs manager approval
3. **Large order:** 250 desks → over $50,000, so it's flagged for approval
4. **Unknown product:** caller asks for laptops → Quinn explains what it can quote instead
5. **Change of mind:** caller changes quantities mid-order → Quinn confirms and re-prices

## Files
- [`system_prompt.txt`](system_prompt.txt): Quinn's personality, quoting flow, and rules
- [`pricing_api.ts`](pricing_api.ts): the pricing service (`POST /quote`, `GET /catalog`)
- [`tool_schema.json`](tool_schema.json): the `calculate_quote` webhook tool definition

## Built with
ElevenLabs ElevenAgents · Val Town (TypeScript HTTP endpoint) · Claude Code

## What's next
- Write accepted quotes to a CRM such as Salesforce, as Quote and Quote Line records
- Add a product search tool so callers can describe items in their own words
- Send the quote PDF by email at the end of the call
- Add an approval workflow that notifies a manager in real time

## Related
- [Riley: Dealer Billing Voice Agent](https://github.com/levi-kurtright/elevenlabs-billing-voice-agent), which handles billing questions after the sale
