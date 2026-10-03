"""
Central Pydantic schemas — used by routers, services, and AI layer.
These are the contracts that every module must honour.
"""
from __future__ import annotations
from pydantic import BaseModel, Field, model_validator
from typing import Optional, List, Literal
from uuid import UUID
from datetime import datetime

# Unit that each zone_type MUST use — enforced at both FE and BE
_ZONE_UNIT_MAP: dict[str, str] = {
    "main_walls":         "sqft",
    "columns_pillars":    "sqft",
    "parapet_wall":       "sqft",
    "balcony_floor":      "sqft",
    "balcony_railing":    "linear_ft",
    "gate_grille":        "count",
    "gate_boundary_wall": "sqft",
    "roof_edge_railing":  "linear_ft",
}

# ─── ENUMS (mirror DB enums exactly) ─────────────────────────────────────────

ZoneType = Literal[
    "main_walls",
    "columns_pillars",
    "parapet_wall",
    "balcony_floor",
    "balcony_railing",
    "gate_grille",
    "gate_boundary_wall",
    "roof_edge_railing",
]

MaterialType = Literal[
    "paint",
    "stone_cladding",
    "texture_finish",
    "tiles",
    "glass_railing",
    "metal_railing",
    "acp_panels",
    "metal_gate",
]

MeasurementUnit = Literal["sqft", "linear_ft", "count"]

Tier = Literal["economy", "standard", "premium"]

ProjectStatus = Literal[
    "pending",
    "detecting",
    "hitl",
    "material_selection",
    "rendering",
    "completed",
    "failed",
]

# ─── AUTH ─────────────────────────────────────────────────────────────────────

class GoogleAuthRequest(BaseModel):
    id_token: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    credits: int


# ─── ZONES ────────────────────────────────────────────────────────────────────

class ZoneOut(BaseModel):
    id: str
    zone_type: ZoneType
    measurement_value: float
    measurement_unit: MeasurementUnit
    ai_detected: bool


class ZoneSave(BaseModel):
    """Sent by frontend after HITL review — confirmed list of zones."""
    zone_type: ZoneType
    measurement_value: float = Field(gt=0)
    measurement_unit: MeasurementUnit
    ai_detected: bool = True


# ─── ZONE MATERIALS ───────────────────────────────────────────────────────────

class ZoneMaterialSave(BaseModel):
    zone_id: str
    material_type: MaterialType
    color: Optional[str] = None     # hex, paint + texture_finish only
    pattern: Optional[str] = None   # texture_finish only


class ZoneMaterialOut(BaseModel):
    id: str
    zone_id: str
    zone_type: ZoneType
    material_type: MaterialType
    color: Optional[str] = None
    pattern: Optional[str] = None


# ─── COST ─────────────────────────────────────────────────────────────────────

class CostLineItemOut(BaseModel):
    zone_id: str
    zone_type: ZoneType
    material_type: MaterialType
    measurement: float
    measurement_unit: MeasurementUnit
    material_rate: float
    material_cost: float
    labor_rate: float
    labor_cost: float
    zone_total: float
    liters_needed: Optional[float] = None
    num_tiles: Optional[int] = None
    color: Optional[str] = None
    pattern: Optional[str] = None


# ─── PROJECT ──────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    """Nothing required — project starts as a blank shell."""
    pass


class ProjectOut(BaseModel):
    id: str
    user_id: str
    status: ProjectStatus
    tier: Optional[Tier] = None
    original_image_url: Optional[str] = None
    unusable_reason: Optional[str] = None  # set when AI rejects the image
    render_image_url: Optional[str] = None
    render_count: int
    total_cost: Optional[float] = None
    created_at: str
    zones: List[ZoneOut] = []
    zone_materials: List[ZoneMaterialOut] = []
    cost_line_items: List[CostLineItemOut] = []


# ─── REQUESTS ─────────────────────────────────────────────────────────────────

class SaveZonesRequest(BaseModel):
    zones: List[ZoneSave]

    @model_validator(mode="after")
    def validate_zones(self) -> "SaveZonesRequest":
        """
        Three rules enforced server-side (frontend also enforces all three):

        1. Each zone_type may appear at most once — duplicates would double-count
           in cost calculation.
        2. measurement_unit must match the canonical unit for the zone_type —
           e.g. main_walls must be sqft, gate_grille must be count. A mismatch
           would produce nonsense cost figures.
        3. gate_grille (count type) must be a whole number — 1.5 gates makes
           no physical sense and breaks per-unit pricing.
        """
        types = [z.zone_type for z in self.zones]
        if len(types) != len(set(types)):
            raise ValueError("Each zone type may only appear once per project")

        for z in self.zones:
            expected_unit = _ZONE_UNIT_MAP.get(z.zone_type)
            if expected_unit and z.measurement_unit != expected_unit:
                raise ValueError(
                    f"'{z.zone_type}' requires unit '{expected_unit}', "
                    f"but received '{z.measurement_unit}'"
                )
            if z.zone_type == "gate_grille" and z.measurement_value != int(z.measurement_value):
                raise ValueError("gate_grille count must be a whole number (no decimals)")

        return self


class SaveMaterialsRequest(BaseModel):
    tier: Tier
    materials: List[ZoneMaterialSave]
    retry_notes: Optional[str] = None   # filled on 2nd render (retry flow)


class UpdateCostItemIn(BaseModel):
    zone_id: str
    measurement: float = Field(gt=0)
    material_rate: float = Field(gt=0)
    labor_rate: float = Field(gt=0)


class UpdateCostsRequest(BaseModel):
    items: List[UpdateCostItemIn]


class RerenderRequest(BaseModel):
    retry_notes: str = Field(min_length=1)


# ─── AI INTERNAL CONTRACTS ───────────────────────────────────────────────────

class DetectedZone(BaseModel):
    """What the AI detection step must return — model-agnostic contract."""
    zone_type: ZoneType
    measurement_value: float
    measurement_unit: MeasurementUnit
    confidence: float = Field(ge=0.0, le=1.0)


class DetectionResult(BaseModel):
    usable: bool                            # False = image rejected by AI
    unusable_reason: Optional[str] = None  # user-friendly message if usable=False
    zones: List[DetectedZone] = []
    raw_response: dict = {}                # raw AI output for audit/debugging
