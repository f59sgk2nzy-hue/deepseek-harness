---
name: supply-chain-intel
description: Map who competitors, customers, and prospects currently buy from, using public trade and regulatory records, to find sourcing alternatives and sales openings.
version: 1.0.0
metadata:
  hermes:
    tags: [intelligence, trade-data, sales]
    category: sourcing
    requires_toolsets: [web]
---

# Supply Chain Intelligence

## When to Use

- Competitor mode: "Who supplies distributor X?" to find proven factories and benchmark costs.
- Customer and prospect mode: "What is customer Y importing directly?" to find items the company could supply, stock, or kit.

## Procedure

1. Public and properly licensed sources only (see Pitfalls). Work through:
   - US import bill-of-lading records (ImportYeti free; Panjiva, ImportGenius, or similar if licensed): consignee, shipper, notify party, product text, HS code, ports, frequency, container counts.
   - SEC filings: 10-K supplier concentration, Form SD conflict-minerals reports naming smelters and suppliers.
   - Customer approved-supplier and approved-processor lists that primes publish, and Nadcap approvals.
   - Government contracts and subawards (USAspending, SAM.gov) for who supplies whom on federal work.
   - Press releases, trade-show exhibitor and visitor case studies, supplier-award announcements, and vendor websites that list customers.
   - Job postings that name supplier systems, sourcing regions, or qualification projects.
2. Build a relationship table with `templates/supplier-map.md`: buyer, supplier, product, country, first/last seen, volume signal, source, confidence.
3. Interpret, labeling inference as inference:
   - Competitor mode: which factories are proven on the US market for this product; how recent and steady; likely landed cost from declared values or published import unit values (Census USA Trade Online by HS code).
   - Customer mode: items they import in full containers that the company could supply in smaller lots, from stock, with certs, VMI, or kitting; switching triggers such as tariff jumps, late shipments, or supplier changes.
4. Hand off: feed proven factories to vendor-due-diligence; feed customer openings to competitive-advantage.

## Pitfalls

- Importers can request manifest confidentiality from CBP, and many goods move by air, rail, or truck without public manifests. Absence of records is not evidence of no supplier.
- Never pretext (pose as a customer, student, or journalist), solicit confidential information from a competitor's current or former staff, bypass logins, or breach a data provider's terms. Stop and tell the buyer if a lead requires that.
- Treat names in shipping records as possibly forwarders or affiliates until confirmed.

## Verification

Every relationship in the map has a source link, dates, and a confidence level; inferences are marked as such.
