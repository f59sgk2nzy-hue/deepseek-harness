---
name: landed-cost-model
description: Compute and compare total landed cost per unit for overseas quotes versus the current source, with every duty and fee itemized.
version: 1.0.0
metadata:
  hermes:
    tags: [cost, tariffs, logistics]
    category: sourcing
    requires_toolsets: [terminal]
---

# Landed Cost Model

## When to Use

When quotes or indicative prices exist and the buyer needs an apples-to-apples comparison.

## Procedure

1. Normalize each quote to the same Incoterm (Incoterms 2020), currency, unit, and quantity break. Record the FX rate and date.
2. Gather inputs per scenario; mark each as quoted, estimated, or broker-confirmed:
   - Unit price, MOQ, tooling (amortized over expected volume).
   - Freight to US port, inland freight to Wichita, insurance.
   - Duty rates: general, Section 301, Section 232, any other current tariffs, AD/CVD (from trade-compliance-screen, dated).
   - MPF and HMF (check current CBP rates and MPF min/max), customs broker fee.
   - Inspection and qualification cost, expected defect or scrap rate.
   - Inventory carrying cost for the added lead time and safety stock.
3. Write the inputs as JSON and run `python3 scripts/landed_cost.py inputs.json`.
4. Report per-unit landed cost, savings vs current source, payback of one-time costs, and sensitivity: what tariff increase or FX move erases the saving.

## Pitfalls

- Comparing FOB overseas to delivered domestic prices.
- Ignoring carrying cost of 10-16 weeks of extra pipeline inventory.

## Verification

The script runs without error and the summary shows each cost line, its basis, and the break-even tariff.
