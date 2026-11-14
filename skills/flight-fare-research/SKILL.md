---
name: flight-fare-research
description: "Honest US flight-fare research for travel agents and assistants — what passengers actually paid on a US domestic route (U.S. DOT Consumer Airfare Report), the cheaper nearby airport pair in the same metro (MIA vs FLL, JFK vs LGA vs EWR, LAX vs BUR/LGB/SNA), the lower-fare carrier, year-over-year change and the cheapest quarter to fly. Use when the user asks \"is this fare good\", \"which New York airport is cheaper from Miami\", \"when is the cheapest time to fly this route\" or wants a benchmark before booking. Benchmark data, not live prices. 100 free calls/day with no key; then USDC per call via x402."
---

# Flight fare research (US domestic)

Read-only REST call to `https://intel.degenscan.io`. One HTTPS GET returns JSON.

## Pick the call

| Question | Call | Price |
|---|---|---|
| Average fare paid on a route, cheaper nearby airports, lower-fare carrier, cheapest quarter | `GET /v1/travel/airfare?from=MIA&to=LGA` (3-letter US airport codes) | $0.002 |

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/travel/airfare?from=MIA&to=LGA"
```

Read:
- `latest.avg_fare_each_way`: the average fare paid in the latest DOT quarter, each way, including taxes and all cabins.
- `nearby_airports.cheapest_alternative`: another airport pair in the same two metros with a lower average fare, and `vs_requested_pct`.
- `lower_fare_carrier`: a carrier whose average is below the dominant carrier's.
- `seasonality.cheapest_quarter`: the travel quarter with the lowest average fare over the last 3 years.
- `year_over_year.change_pct`: the change against the same quarter a year earlier.

## How to use it with a live quote

1. Get the benchmark here.
2. Get the live price from the airline or a booking site that the user chooses.
3. A live quote well below `avg_fare_each_way` is a good fare. One well above it is worth comparing with the cheaper nearby airport and the lower-fare carrier.

## Rules for the agent

- Say that these are **average fares paid**, not today's price, and quote the `latest.period`. The data lags about 5–6 months.
- The data covers US domestic routes in the 48 contiguous states only.
- Do not suggest "hidden-city" ticketing, fake locations or VPN tricks. They break the airline's contract of carriage, and the airline can cancel the rest of the trip or remove miles.
- Do not claim that searching repeatedly or clearing cookies changes the price. There is no reliable evidence for it.
- Quote the source "U.S. DOT Domestic Airline Consumer Airfare Report".
- Operator: Degenscan Intel (Marbella Collins LLC) · contact@degenscan.io. Not affiliated with the U.S. DOT or any airline.

## Access and payment

- **Free trial, no signup:** send the header `X-Free-Trial: 1` (100 calls per day per IP).
- **Then pay per call in USDC** with any x402 client (Base `eip155:8453` or Solana). An unpaid call returns HTTP 402 with the price.
- **Or use a prepaid key:** `POST https://intel.degenscan.io/v1/keys/x402/balance_5`, then send the header `X-API-KEY`.
- **MCP:** `https://intel.degenscan.io/mcp`.
- **Docs:** `https://intel.degenscan.io/llms.txt`.
