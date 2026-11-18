---
name: sourcing-intake
description: Turn a buyer's sourcing request into a complete sourcing brief before any vendor research starts.
version: 1.0.0
metadata:
  hermes:
    tags: [sourcing, procurement, apac]
    category: sourcing
---

# Sourcing Intake

## When to Use

Any new request to find, replace, add, or compare a supplier for a material or part.

## Procedure

1. Read `references/company-profile.md` for company defaults (quality system, approved countries, payment terms, ports). If it still contains placeholders, ask the buyer to fill it once.
2. Fill `templates/sourcing-brief.md`. Ask only for fields that change the search:
   - Item: material/grade/spec, standard (ASTM, SAE, AMS, MIL, ISO), dimensions, tolerances, finish.
   - End market: aerospace, ag, general industrial. Aerospace triggers DFARS specialty-metals, AS9100, and export-control checks.
   - Volume: annual usage, order quantity, release pattern, current stock position.
   - Commercial: current price and supplier, target landed cost, Incoterm preference, payment terms.
   - Quality: required certs (mill test report EN 10204 3.1, CoC, RoHS/REACH, FAI AS9102, PPAP level), inspection needs.
   - Timing: needed-by date, acceptable lead time, qualification time available.
   - Constraints: excluded countries, customer-mandated sources, domestic-content or Berry/DFARS requirements, export-controlled technical data.
3. Confirm the brief in one message. Mark which fields are assumptions.
4. Propose the research plan: target countries with reasons, skills to run, and expected deliverables.

## Pitfalls

- Starting vendor search before knowing end market and cert requirements wastes the whole search.
- If the item's drawing is export-controlled, research must use generic material/process descriptions only.

## Verification

The brief has no blank required field, and the buyer approved the research plan.
