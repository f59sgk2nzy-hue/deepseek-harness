---
name: trade-compliance-screen
description: Screen a vendor and an item for US sanctions, forced-labor, tariff, origin, and defense-content risks before any commitment.
version: 1.0.0
metadata:
  hermes:
    tags: [compliance, trade, sanctions, tariffs]
    category: sourcing
    requires_toolsets: [web]
---

# Trade Compliance Screen

## When to Use

For every short-listed vendor and every item before RFQ, and again before first PO.

## Procedure

1. Party screening on the vendor, its parent, owners, and known affiliates (all name variants):
   - US Consolidated Screening List (trade.gov), which aggregates OFAC SDN and other OFAC lists, BIS Entity List, Unverified List, Military End-User List, and State Department lists.
   - DHS UFLPA Entity List.
   - Note the BIS 50% affiliates rule status and OFAC 50% rule: ownership by a listed party can make an unlisted vendor restricted.
2. Forced labor (UFLPA): any input traceable to Xinjiang is presumed barred. Ask what supply-chain tracing the vendor can document for high-risk inputs (aluminum, polysilicon, cotton, PVC, some steel and rubber inputs).
3. Tariff exposure (for the broker to confirm): likely HTS classification, general duty rate, Section 301 (China), Section 232 (steel, aluminum, copper, derivatives), any current IEEPA or reciprocal tariffs, and antidumping/countervailing duty orders on the product and country. Check USITC HTS and CBP/ITA AD/CVD sources live; record the date.
4. Origin and transshipment: for non-China vendors, check whether substantial transformation happens locally or Chinese material is relabeled; AD/CVD and 301 evasion findings follow the material.
5. Defense and aerospace: if the end use is US defense, flag DFARS 252.225-7009 specialty-metals requirements (qualifying-country melt) and any customer domestic-content flow-downs. If technical data is ITAR or EAR controlled, sharing it with a foreign vendor requires a license or exemption: stop and escalate.
6. Output a red/amber/green table per vendor and item, with the source and date for each line, and the questions for the customs broker and compliance officer.

## Pitfalls

- Tariff stacks changed repeatedly in 2025-2026; never reuse a rate from memory or an old quote.
- A clean screen on the trade name with a listed parent is not clean.
- These are risk flags, not legal determinations.

## Verification

Every vendor and item has a dated screen result with links; every amber/red item names who must clear it.
