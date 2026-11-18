---
name: vendor-due-diligence
description: Verify an APAC vendor's legal existence, ownership, factory status, certifications, and track record from independent sources.
version: 1.0.0
metadata:
  hermes:
    tags: [sourcing, due-diligence, apac]
    category: sourcing
    requires_toolsets: [web]
---

# Vendor Due Diligence

## When to Use

For each short-listed vendor (typically the top 5-8 from discovery) before samples or RFQ.

## Procedure

1. Legal existence: match name, registration number, address, legal representative, registered capital, founding date, and business scope against the official registry:
   - China: National Enterprise Credit Information Publicity System (gsxt.gov.cn); check business scope covers manufacturing, not only trading.
   - Taiwan: GCIS company search (findbiz.nat.gov.tw). Japan: corporate number site (houjin-bangou.nta.go.jp) and gBizINFO. South Korea: DART (dart.fss.or.kr) for filers.
   - Singapore: ACRA BizFile. Malaysia: SSM. Thailand: DBD DataWarehouse. Vietnam: National Business Registration Portal. India: MCA company master data. Indonesia and Philippines: AHU and SEC respectively.
2. Factory or trader: compare registry scope, registered address vs claimed factory address (satellite/street imagery), equipment lists, headcount, and whether US import records list them as shipper.
3. Certifications: confirm each certificate in the issuing database (IAF CertSearch, IAQG OASIS for AS9100, UL Product iQ, Nadcap eAuditNet for special processes). Check scope, site address, and expiry match. A PDF certificate alone is VENDOR-CLAIMED.
4. Track record: US import history (volume, consistency, named buyers), years active, litigation or enforcement news, negative-press search in English and the local language.
5. Ownership and affiliates: parent companies and shareholders, for the trade-compliance screen.
6. Fill `templates/vendor-dossier.md` and assign a risk rating with reasons.

## Pitfalls

- Registry name in local script often differs from the English trade name; search both.
- A certificate for a different site of the same group does not cover this factory.
- Registered capital is declared, not paid-in, in many jurisdictions.

## Verification

Every dossier field is labeled VERIFIED (with link), VENDOR-CLAIMED, or UNVERIFIED, and the check date is recorded.
