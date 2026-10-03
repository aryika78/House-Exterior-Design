"""
Cost Calculation Service — pure math, no AI dependency.

Catalog rates (INR) by material type + tier. Research-verified current Indian market rates.
Sources: comaron.com, aecord.com, imperiorailing.com, grillwale.com, zenstone.in,
         nobroker.in, aapkapainter.com.

All rates are per sqft (area materials), per linear_ft (railing), or per unit (gate).
Paint also outputs liters_needed as a display value.
Tiles outputs num_tiles count.

Labor rates are FIXED per material type regardless of tier — only material cost
changes by tier (as per arch spec).

Wastage (CPWD standard + India construction norms):
  paint:           10%  — overlap, extra coats
  stone_cladding:  15%  — cutting at corners and edges
  texture_finish:  10%  — surface prep loss
  tiles:           10%  — straight lay, cutting and breakage
  glass_railing:    5%  — pre-cut supply, minimal site waste
  metal_railing:    5%  — pre-fabricated, minimal site waste
  acp_panels:      10%  — cutting waste at edges
  metal_gate:       0%  — whole unit, counted as-is
"""
import logging
import math
from app.db.client import get_db

logger = logging.getLogger(__name__)

# ─── CATALOG RATES ────────────────────────────────────────────────────────────
# Structure: RATES[material_type][tier] = {material_rate, labor_rate}
# material_rate: INR per sqft / linear_ft / unit (material cost only)
# labor_rate:    INR per sqft / linear_ft / unit (SAME across all tiers for a material)

RATES: dict = {
    "paint": {
        # Material: acrylic exterior emulsion, supplied + applied (2 coats, contractor supply markup)
        # Labor: includes primer coat, 2 finish coats, edge masking (Rs 30/sqft — comaron.com)
        "economy":  {"material_rate": 18,  "labor_rate": 30},
        "standard": {"material_rate": 28,  "labor_rate": 30},
        "premium":  {"material_rate": 45,  "labor_rate": 30},
    },
    "stone_cladding": {
        # Material: natural stone supply (Kota/Slate → Sandstone → Granite)
        # Labor: cutting, fixing, grouting — Rs 100/sqft (aecord.com, range Rs 80–120)
        "economy":  {"material_rate": 100, "labor_rate": 100},
        "standard": {"material_rate": 200, "labor_rate": 100},
        "premium":  {"material_rate": 380, "labor_rate": 100},
    },
    "texture_finish": {
        # Material: acrylic/polymer texture finish, supplied + applied
        # Labor: Rs 50/sqft (aapkapainter.com, range Rs 40–70)
        "economy":  {"material_rate": 35,  "labor_rate": 50},
        "standard": {"material_rate": 60,  "labor_rate": 50},
        "premium":  {"material_rate": 90,  "labor_rate": 50},
    },
    "tiles": {
        # Material: ceramic/vitrified/GVT tile supply
        # Labor: Rs 50/sqft (comaron.com, range Rs 45–90)
        "economy":  {"material_rate": 45,  "labor_rate": 50},
        "standard": {"material_rate": 85,  "labor_rate": 50},
        "premium":  {"material_rate": 150, "labor_rate": 50},
    },
    "glass_railing": {
        # Material: glass + frame/spigots/channel hardware
        # Labor: Rs 800/lft (imperiorailing.com, range Rs 500–1500)
        "economy":  {"material_rate": 700,  "labor_rate": 800},
        "standard": {"material_rate": 1500, "labor_rate": 800},
        "premium":  {"material_rate": 2500, "labor_rate": 800},
    },
    "metal_railing": {
        # Material: MS or SS 304 railing fabrication
        # Labor: Rs 150/lft (grillwale.com, range Rs 120–200)
        "economy":  {"material_rate": 400, "labor_rate": 150},
        "standard": {"material_rate": 600, "labor_rate": 150},
        "premium":  {"material_rate": 900, "labor_rate": 150},
    },
    "acp_panels": {
        # Material: ACP sheet supply (3mm PE / 4mm PVDF / 4mm Architectural)
        # Labor: Rs 30/sqft (pioneerpanels.com, range Rs 25–40)
        "economy":  {"material_rate": 90,  "labor_rate": 30},
        "standard": {"material_rate": 150, "labor_rate": 30},
        "premium":  {"material_rate": 220, "labor_rate": 30},
    },
    "metal_gate": {
        # Material: fabricated gate unit (MS single / MS double / SS 304 double)
        # Labor: Rs 600/unit — installation and fitting (grillwale.com)
        "economy":  {"material_rate": 10000, "labor_rate": 600},
        "standard": {"material_rate": 20000, "labor_rate": 600},
        "premium":  {"material_rate": 40000, "labor_rate": 600},
    },
}

WASTAGE: dict = {
    "paint":          0.10,
    "stone_cladding": 0.15,
    "texture_finish": 0.10,
    "tiles":          0.10,   # straight lay standard (CPWD); was 0.15, corrected
    "glass_railing":  0.05,
    "metal_railing":  0.05,
    "acp_panels":     0.10,
    "metal_gate":     0.00,
}

# Paint: coverage in sqft per liter (practical, 2 coats — Asian Paints Apex spec sheet)
# 100 sqft/liter across all tiers (theoretical 110–130, practical conservative = 100)
PAINT_COVERAGE_SQFT_PER_LITER: float = 100.0

# Tile dimensions per tier (sqft per tile, for num_tiles calculation)
# Economy / Standard: 600×600mm = 0.6×0.6m = 3.875 sqft ≈ 3.9 sqft
# Premium:            600×1200mm = 0.6×1.2m = 7.75 sqft
TILE_SQFT_BY_TIER: dict = {
    "economy":  3.9,
    "standard": 3.9,
    "premium":  7.75,
}


def calculate_costs(project_id: str) -> None:
    """
    Calculate costs for all zones in a project.
    Reads zones + zone_materials from DB, writes cost_line_items, updates project.total_cost.
    Called after render completes (or can be called independently for testing).
    """
    db = get_db()

    # Fetch project tier
    project = db.table("projects").select("tier").eq("id", project_id).execute().data[0]
    tier = project["tier"]
    logger.info("Cost calculation started — project_id=%s tier=%s", project_id, tier)

    # Fetch zones
    zones = db.table("zones").select("*").eq("project_id", project_id).execute().data or []

    # Fetch materials
    materials = (
        db.table("zone_materials")
        .select("*")
        .eq("project_id", project_id)
        .execute()
        .data or []
    )

    # Build zone_id → material map
    material_map = {m["zone_id"]: m for m in materials}

    # Clear existing cost_line_items (idempotent recalculation)
    db.table("cost_line_items").delete().eq("project_id", project_id).execute()

    total = 0.0
    line_items = []

    for zone in zones:
        zone_id = zone["id"]
        material_row = material_map.get(zone_id)
        if not material_row:
            continue  # zone has no material (shouldn't happen, but safe)

        material_type = material_row["material_type"]
        measurement = float(zone["measurement_value"])
        measurement_unit = zone["measurement_unit"]

        if material_type not in RATES:
            raise ValueError(
                f"Unknown material type '{material_type}' — not found in pricing catalog. "
                "Check zone_materials table for this project."
            )
        if tier not in RATES[material_type]:
            raise ValueError(
                f"Unknown tier '{tier}' for material '{material_type}'. "
                "Tier must be one of: economy, standard, premium."
            )
        rates = RATES[material_type][tier]
        material_rate = rates["material_rate"]
        labor_rate = rates["labor_rate"]
        wastage = WASTAGE[material_type]

        # Apply wastage to measurement for cost calculation
        effective_measurement = measurement * (1 + wastage)

        material_cost = round(effective_measurement * material_rate, 2)
        labor_cost = round(measurement * labor_rate, 2)  # net area only — wastage is material-only
        zone_total = round(material_cost + labor_cost, 2)

        # Special fields
        liters_needed = None
        num_tiles = None

        if material_type == "paint":
            liters_needed = round(effective_measurement / PAINT_COVERAGE_SQFT_PER_LITER, 2)

        if material_type == "tiles":
            tile_sqft = TILE_SQFT_BY_TIER[tier]
            num_tiles = math.ceil(effective_measurement / tile_sqft)

        line_item = {
            "project_id": project_id,
            "zone_id": zone_id,
            "zone_type": zone["zone_type"],
            "material_type": material_type,
            "measurement": measurement,
            "measurement_unit": measurement_unit,
            "material_rate": material_rate,
            "material_cost": material_cost,
            "labor_rate": labor_rate,
            "labor_cost": labor_cost,
            "zone_total": zone_total,
            "liters_needed": liters_needed,
            "num_tiles": num_tiles,
            "color": material_row.get("color"),
            "pattern": material_row.get("pattern"),
        }
        line_items.append(line_item)
        total += zone_total

    if line_items:
        db.table("cost_line_items").insert(line_items).execute()

    db.table("projects").update({"total_cost": round(total, 2)}).eq("id", project_id).execute()
    logger.info(
        "Cost calculation complete — project_id=%s zones=%d total=₹%.2f",
        project_id, len(line_items), total,
    )
