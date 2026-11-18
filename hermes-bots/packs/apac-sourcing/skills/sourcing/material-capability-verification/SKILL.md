---
name: material-capability-verification
description: Check whether a vendor can actually make the material or part to the required spec, including foreign-to-US standard equivalence and certification evidence.
version: 1.0.0
metadata:
  hermes:
    tags: [materials, quality, engineering]
    category: sourcing
    requires_toolsets: [web]
---

# Material and Capability Verification

## When to Use

When comparing a vendor's material, grade, or process capability against the sourcing brief.

## Procedure

1. Map the required spec to the vendor's local standard (GB, JIS, KS, CNS, IS, etc.). Produce a side-by-side table of chemistry, mechanical properties, heat treatment, tolerances, and test methods. "Equivalent" grades often differ in impurity limits, test temperature, or tolerance class; list every difference.
2. Decide whether the difference matters for the end use; if unsure, mark it for the buyer's quality engineer.
3. Capability evidence: process (melt, cast, forge, machine, heat-treat, plate), in-house vs outsourced steps, equipment size limits, inspection equipment (CMM, spectrometer, hardness, tensile), and lab accreditation (ISO/IEC 17025).
4. Required documentation the vendor must be able to supply: mill test report to EN 10204 3.1 (or 3.2), certificate of conformance, material traceability to heat/lot, RoHS/REACH declarations, conflict-minerals reporting template, FAI per AS9102 or PPAP at the required level.
5. Request a sample MTR (buyer sends) and check it for heat number, standard cited, actual vs spec values, and the issuing mill. MTRs from a trading company should trace to a named mill.

## Pitfalls

- Treating a cross-reference chart as proof of equivalence.
- Outsourced heat treatment or plating breaks the vendor's own quality certification scope.

## Verification

An equivalence table with every deviation listed and a pass/flag per requirement, citing the standards used.
