"""Landed cost per unit for sourcing scenarios.

Usage: python3 landed_cost.py inputs.json

inputs.json:
{
  "annual_units": 50000,
  "carrying_cost_rate": 0.20,          # annual, fraction of unit value
  "current": {"name": "Domestic incumbent", "landed_unit_cost": 1.85},
  "scenarios": [{
    "name": "Vendor A (FOB Ningbo)",
    "unit_price": 0.92,                # in USD after FX
    "freight_per_unit": 0.06,          # ocean + inland + insurance
    "duty_rates": {"general": 0.034, "section_301": 0.25},
    "fees_rate": 0.005,                # MPF + HMF approx, as fraction of customs value
    "broker_per_unit": 0.01,
    "quality_per_unit": 0.03,          # inspection + expected scrap
    "one_time_cost": 6000,             # tooling, samples, audit, FAI
    "added_lead_time_weeks": 12
  }]
}
"""
import json
import sys


def landed(s: dict, annual_units: float, carrying_rate: float) -> dict:
    customs_value = s["unit_price"]
    duty_rate = sum(s.get("duty_rates", {}).values())
    duty = customs_value * duty_rate
    fees = customs_value * s.get("fees_rate", 0.0)
    pre_carry = (customs_value + s.get("freight_per_unit", 0.0) + duty + fees
                 + s.get("broker_per_unit", 0.0) + s.get("quality_per_unit", 0.0))
    carry = pre_carry * carrying_rate * s.get("added_lead_time_weeks", 0) / 52
    one_time = s.get("one_time_cost", 0.0) / annual_units
    return {
        "name": s["name"], "unit_price": customs_value, "freight": s.get("freight_per_unit", 0.0),
        "duty_rate": duty_rate, "duty": duty, "fees": fees,
        "broker": s.get("broker_per_unit", 0.0), "quality": s.get("quality_per_unit", 0.0),
        "carrying": carry, "one_time_per_unit_yr1": one_time,
        "landed_steady_state": pre_carry + carry, "landed_year1": pre_carry + carry + one_time,
    }


def break_even_extra_tariff(s: dict, r: dict, current: float) -> float | None:
    """Additional duty rate (fraction of customs value) that makes steady-state landed cost equal current."""
    if s["unit_price"] <= 0:
        return None
    return (current - r["landed_steady_state"]) / s["unit_price"]


def main() -> None:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    n = cfg["annual_units"]
    rate = cfg.get("carrying_cost_rate", 0.2)
    cur = cfg["current"]["landed_unit_cost"]
    print(f"Current: {cfg['current']['name']} ${cur:.4f}/unit, {n:,} units/yr\n")
    for s in cfg["scenarios"]:
        r = landed(s, n, rate)
        print(f"== {r['name']}")
        for k in ("unit_price", "freight", "duty", "fees", "broker", "quality", "carrying"):
            print(f"  {k:<12} ${r[k]:.4f}")
        print(f"  {'(duty rate)':<12} {r['duty_rate']:.1%}")
        print(f"  landed (steady) ${r['landed_steady_state']:.4f}   year 1 incl. one-time ${r['landed_year1']:.4f}")
        save = cur - r["landed_steady_state"]
        print(f"  saving vs current ${save:.4f}/unit ({save / cur:.1%}), ${save * n:,.0f}/yr")
        if save > 0 and s.get("one_time_cost"):
            print(f"  payback on one-time cost: {s['one_time_cost'] / (save * n) * 12:.1f} months")
        be = break_even_extra_tariff(s, r, cur)
        if be is not None:
            print(f"  break-even: an extra {be:.1%} tariff erases the saving")
        print()


if __name__ == "__main__":
    main()
