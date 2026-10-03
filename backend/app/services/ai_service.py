"""
AI Detection Service — model-agnostic zone detection.

Contract:
  Input : project_id (str), image_path (str), house_width (float | None)
  Output: writes zones to DB, updates project status

Status outcomes:
  - AI says usable + zones found  → status = 'hitl'
  - AI says unusable              → status = 'pending', unusable_reason saved (user can re-upload)
  - System/network error          → status = 'failed'

Background task called from: projects.py → upload endpoint
"""
import json
import logging
from typing import Optional
from app.db.client import get_db
from app.models.schemas import DetectionResult, DetectedZone
from app.services.storage_service import read_image_bytes

logger = logging.getLogger(__name__)


# ─── DETECTION PROMPT ─────────────────────────────────────────────────────────
#
# Sent to vision model with the house exterior image.
# house_width_line is injected dynamically based on whether user provided a width.

_DETECTION_PROMPT_BASE = """
You are an expert AI vision system that analyzes residential building exterior photographs
for renovation planning and cost estimation. You are given a photograph of a building's
exterior and optional metadata provided by the user.

Your job has two phases in a single response:
  Phase 1 — Decide if the image is usable for renovation zone analysis
  Phase 2 — If usable, detect and measure all present renovation zones

__HOUSE_WIDTH_CONTEXT__

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — IMAGE USABILITY ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Evaluate whether this image can be reliably analyzed for renovation zone detection.

USABLE — all of the following must be true:
  • Subject is a residential or mixed-use building exterior: house, apartment, villa,
    bungalow, row house, plotted development, or any structure where exterior renovation
    (painting, cladding, railings, gates, boundary walls) applies.
  • At least one building facade (front, side, or diagonal) is visible and identifiable —
    even if partially obstructed, as long as some structural zones can be seen.
  • Shot from approximately ground level or low-to-mid elevation — any angle where at least
    one facade surface is visible works. Moderate diagonal angles are fine.
  • Structural elements (wall edges, railings, gate, pillars) are distinguishable —
    moderate blur, overcast lighting, or shadows are acceptable if zones are identifiable.
  • At least one full floor of the building is visible, or enough of the facade is in frame
    to allow estimation of at least one zone's measurement.
  • Default to attempting analysis. Only reject when analysis is genuinely impossible.

UNUSABLE — if any one of these is true:
  • Wrong content: no building in the image — interior rooms, pure landscape without a
    building, vehicles, people only, abstract patterns.
  • Wrong structure type: purely industrial warehouses, factory sheds, or structures where
    no residential exterior renovation zone applies. When uncertain, attempt analysis.
  • Facade completely blocked: building covered by scaffolding, dense foliage, construction
    materials such that no wall, railing, gate, or structural element is visible anywhere.
  • Severe image degradation: so blurry or corrupted that no structural element can be
    identified — not a wall edge, not a door frame, nothing.
  • Total exposure failure: completely pitch black OR completely washed out with all
    structural detail entirely lost — not just slightly dark or bright, but total loss.
  • Pure top-down aerial: shot directly above, showing only the roof plan — no facade
    surface visible at all.
  • Unusable fragment: shows less than 25% of a single floor — a tiny sliver where no
    meaningful zone can be identified or measured.

IF UNUSABLE — respond with this JSON and stop:
{
  "usable": false,
  "unusable_reason": "<Clear, friendly explanation for a non-technical homeowner. State
    specifically what you saw, why analysis is not possible, and what type of photo to
    take instead. Example: 'The photo appears to be of a room interior. To estimate
    renovation costs, please take a photo from outside your home, standing at street
    level and facing the front or side of the building so the full exterior is in view.'>",
  "zones": []
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 — ZONE DETECTION AND MEASUREMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If the image is usable, identify and measure all renovation zones present in the image.

──────────────────────────────────────────────────────
STEP A — ESTABLISH YOUR MEASUREMENT SCALE
──────────────────────────────────────────────────────

You must anchor your measurements to a real-world scale before estimating any zone.

Priority order for scale reference (use the most reliable one visible):

  1. USER-PROVIDED HOUSE WIDTH (highest priority if provided — see metadata above)
     If the user told you the house is X feet wide, use that as your primary horizontal scale.
     Cross-validate against other references if visible.

  2. Entry door: 7 ft tall × 3 ft wide
     Most reliable visual reference. Typical Indian residential standard; Western-style
     or premium construction may use 6.8–8 ft height — adjust if other references confirm.

  3. Window opening: approximately 4 ft tall × 3.5 ft wide
     Typical Indian residential; modern or Western-style homes may have larger openings
     (5–6 ft tall). Cross-validate with door if both are visible.

  4. Parked car: approximately 5 ft tall × 14–15 ft long

  5. Adult human figure: approximately 5.5 ft tall

  6. Floor-to-ceiling height: approximately 10 ft per storey
     Standard Indian residential construction; older or premium builds may be 9–11 ft.
     Use visible door/window proportions to refine if uncertain.

  7. Boundary/compound wall: typically 5.5–6 ft tall

  8. Balcony railing or parapet: typically 3.5–4 ft tall

Once you identify your scale anchor, estimate a pixel-per-foot ratio for this image.
Apply that ratio consistently across all zone measurements.

If multiple references are visible, cross-validate. If they give significantly different
results, use the most reliable one and lower confidence accordingly.

If NO scale reference is visible at all: use standard single-storey height (10 ft) ×
estimated floor count as your vertical anchor, and standard house width proportions
for horizontal. Assign lower confidence to all zones in this case.

──────────────────────────────────────────────────────
STEP B — PERSPECTIVE CORRECTION
──────────────────────────────────────────────────────

If the camera is not perfectly perpendicular to the facade:
  • Surfaces angled away appear narrower than their true width
  • Correction: actual_width ≈ apparent_width / cos(viewing_angle)
  • For moderate angles (15°–35° off-perpendicular): apply a 1.10×–1.20× correction
    to horizontal measurements
  • For steep angles (>45° off-perpendicular): apply correction and reduce confidence
  • Vertical measurements are not affected by horizontal viewing angle

──────────────────────────────────────────────────────
STEP C — DETECT AND MEASURE ZONES
──────────────────────────────────────────────────────

IMPORTANT MEASUREMENT POLICY:
  Measure GROSS areas. Do NOT subtract window or door openings from wall measurements.
  Wall area is reported as the total surface area including openings.
  Reason: accurately estimating window and door dimensions from a single 2D photograph
  is unreliable and introduces more error than the slight overestimate from gross area.
  This is a deliberate system design decision.

Detect ONLY zones from the list below. Do not create other zone types.
Skip any zone not present or not clearly visible in this image.

─────────────────────────────────────────────────────────────────────────────
ZONE 1 — "main_walls" | measurement unit: sqft
─────────────────────────────────────────────────────────────────────────────
What it is:
  The primary exterior wall surfaces forming the main body of the building.
  All plastered, painted, clad, or bare masonry wall areas on visible facades.

How to identify:
  Large vertical flat surfaces spanning floor height, forming the structural
  envelope of the building. Distinguish from: pillar faces (raised protrusions),
  parapet wall (top horizontal band), boundary wall (separate from main building).

How to measure:
  • Estimate the visible facade width (using your scale anchor from Step A)
  • Multiply by total wall height = number of floors × 10 ft per floor
  • Apply perspective correction if camera is angled
  • Report GROSS area — do NOT subtract windows, doors, or any openings
  • Only measure what is visible in this image — do not add unseen sides or
    assume what is around the corner

─────────────────────────────────────────────────────────────────────────────
ZONE 2 — "columns_pillars" | measurement unit: sqft
─────────────────────────────────────────────────────────────────────────────
What it is:
  Decorative or structural vertical columns or pillars on the building facade,
  distinct from the main wall surface.

How to identify:
  Vertical protrusions from the wall — at entrances, corners, or regularly spaced.
  Can be cylindrical, square, or rectangular. Visually distinct from the flat wall
  by being raised, of a different material, or separated by shadow lines.

How to measure:
  • For each visible column face: (face width) × (visible height)
  • Typical face width: 12–18 inches (1–1.5 ft), height spans full floor
  • Sum the face area across all similar visible columns
  • Only count visible faces — do not add unseen sides of columns

Skip if: no columns or pillars are identifiable in this image.

─────────────────────────────────────────────────────────────────────────────
ZONE 3 — "parapet_wall" | measurement unit: sqft
─────────────────────────────────────────────────────────────────────────────
What it is:
  A solid low wall running along the top edge of a flat roof or terrace.
  Provides safety and gives a finished horizontal cap to the roofline.

How to identify:
  A solid (not open/see-through) horizontal band of masonry at the very top of
  the building. Typically 3–4 ft tall, runs the full width of the building.
  Present only on flat-roofed buildings — absent on sloped or pitched-roof buildings.

How to measure:
  • Width = full visible building width (same as main_walls width estimate)
  • Height = typically 3.5 ft (use visual proportion relative to floor height)
  • Area = width × height

Skip if: building has a sloped/gabled/pitched roof, or parapet is not visible.

─────────────────────────────────────────────────────────────────────────────
ZONE 4 — "balcony_floor" | measurement unit: sqft
─────────────────────────────────────────────────────────────────────────────
What it is:
  The floor surface of any balcony projecting from the building.

How to identify:
  A horizontal platform projecting outward from the building wall, typically
  enclosed on the open edge by a railing. Usually associated with a door or
  large window opening behind it.

How to measure:
  • Area = (balcony width) × (balcony depth)
  • Balcony width: measure from wall to outer edge using scale anchor
  • Balcony depth: typically 3.5–5 ft; larger in premium or Western-style homes (up to 6–7 ft)
  • Sum all balconies on all floors if multiple are visible

Skip if: no balcony is present in this image.

─────────────────────────────────────────────────────────────────────────────
ZONE 5 — "balcony_railing" | measurement unit: linear_ft
─────────────────────────────────────────────────────────────────────────────
What it is:
  The railing or barrier running along the open edge(s) of a balcony.

How to identify:
  A barrier (glass, metal grille, or solid concrete) at the outer edge of the
  balcony platform. Typically 3–3.5 ft tall. Located at mid-floor level —
  distinguish from parapet wall (which is at roofline) and roof_edge_railing.

How to measure:
  • Measure the total length of the open railing edge for each balcony (linear ft)
  • This is typically equal to the balcony width
  • Sum across all visible balconies

Skip if: no balcony is present in this image.

─────────────────────────────────────────────────────────────────────────────
ZONE 6 — "gate_grille" | measurement unit: count
─────────────────────────────────────────────────────────────────────────────
What it is:
  The main entrance gate or compound gate — a movable or fixed gate structure
  at the entry point of the property.

How to identify:
  A gate structure (not a wall, not a door) at the boundary of the property —
  typically 5–10 ft tall, metal fabricated, may be ornamental. Located at the
  bottom of the composition near the boundary wall. Can be single-leaf or
  double-leaf. A separate smaller pedestrian gate beside the main vehicle gate
  also counts as a distinct unit.

How to measure:
  Count the distinct gate units visible:
  • 1 vehicle gate = count of 1
  • 1 vehicle gate + 1 separate pedestrian gate = count of 2
  Only count entrance/compound gates — not window grilles or door grilles.

Skip if: no gate is visible in this image.

─────────────────────────────────────────────────────────────────────────────
ZONE 7 — "gate_boundary_wall" | measurement unit: sqft
─────────────────────────────────────────────────────────────────────────────
What it is:
  The compound/boundary wall surrounding the property, separate from the main
  building structure.

How to identify:
  A continuous wall along the plot perimeter — lower than the main house, with
  a distinct flat top edge. Typically 5–7 ft tall. Made of brick, concrete, or
  plastered masonry. Located in the foreground of the image, forming the property
  boundary. Clearly separate from the main building walls.

How to measure:
  • Area = (visible length of boundary wall) × (estimated height, typically 5.5 ft)
  • Apply perspective correction if the wall runs diagonally in the image

Skip if: no boundary wall is visible or clearly distinguishable from the main house.

─────────────────────────────────────────────────────────────────────────────
ZONE 8 — "roof_edge_railing" | measurement unit: linear_ft
─────────────────────────────────────────────────────────────────────────────
What it is:
  An open railing structure along the edge of a flat roof or terrace — distinct
  from a parapet wall, which is solid.

How to identify:
  Open metalwork or glass railing at the roofline — you can see through it (gaps
  between balusters, or transparent glass panels). Located at the very top of the
  building along the roof edge.

  KEY DISTINCTION:
  • Solid wall at roofline = parapet_wall (zone 3)
  • Open/see-through railing at roofline = roof_edge_railing (this zone)
  Never report the same structure as both.

How to measure:
  • Measure the visible length (linear ft) of the open railing along the roofline

Skip if: no open railing is present at the roofline, or the roofline has a solid
parapet (already counted as zone 3).

──────────────────────────────────────────────────────
STEP D — CONFIDENCE SCORING
──────────────────────────────────────────────────────

Assign a confidence score (0.0–1.0) per detected zone:

  0.90–1.00  Zone fully visible, scale anchor is clear and unambiguous, no
             significant occlusion, perspective is near-perpendicular.
  0.70–0.89  Zone mostly visible, scale anchor reasonable, minor occlusion or
             slight angle, small estimation involved.
  0.50–0.69  Zone partially visible or scale is approximate, moderate estimation,
             some occlusion or perspective distortion.
  0.30–0.49  Zone significantly occluded or scale uncertain, rough estimate only,
             treat result as indicative.
  Below 0.30 DO NOT include this zone — estimate is too unreliable to be useful.

If the entire image has no reliable scale reference (no door, window, car, human,
or user-provided width), reduce all zone confidence scores by 0.15.

──────────────────────────────────────────────────────
STEP E — MEASUREMENT FORMATTING RULES
──────────────────────────────────────────────────────

  sqft zones (main_walls, columns_pillars, parapet_wall, balcony_floor,
              gate_boundary_wall):
    → Report as a positive float, rounded to nearest 0.5

  linear_ft zones (balcony_railing, roof_edge_railing):
    → Report as a positive float, rounded to nearest 0.5

  count zones (gate_grille):
    → Report as a whole number integer (1, 2, 3...)

  All measurement_value entries must be > 0.
  Do not include a zone if measurement_value would be 0.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — STRICT JSON ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Respond with ONLY a valid JSON object.
No markdown. No code fences (```). No explanation text. No comments.
The entire response must be parseable by json.loads() without any preprocessing.

{
  "usable": true,
  "unusable_reason": null,
  "zones": [
    {
      "zone_type": "main_walls",
      "measurement_value": 480.0,
      "measurement_unit": "sqft",
      "confidence": 0.75
    },
    {
      "zone_type": "balcony_railing",
      "measurement_value": 28.0,
      "measurement_unit": "linear_ft",
      "confidence": 0.65
    },
    {
      "zone_type": "gate_grille",
      "measurement_value": 1,
      "measurement_unit": "count",
      "confidence": 0.90
    }
  ]
}

Final output rules:
  • Only include zones actually present and visible in this specific image
  • Do not include zones that might exist behind or around unseen parts of the building
  • zone_type must be one of exactly: "main_walls", "columns_pillars", "parapet_wall",
    "balcony_floor", "balcony_railing", "gate_grille", "gate_boundary_wall",
    "roof_edge_railing"
  • measurement_unit must be exactly: "sqft", "linear_ft", or "count"
  • confidence must be a float between 0.0 and 1.0
  • If usable but no zones meet confidence ≥ 0.30, return usable: true with zones: []
""".strip()


# ─── RETRY FALLBACK ────────────────────────────────────────────────────────────
#
# Appended to the prompt only on attempt_number >= 2.
# Instructs the model to never return usable: false on the second attempt —
# it must produce at least a rough main_walls estimate so the user isn't blocked.

_RETRY_FALLBACK_SECTION = """

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECOND ATTEMPT — MANDATORY FALLBACK BEHAVIOUR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This is the user's SECOND upload attempt. Their previous image could not be analysed.
This is their last AI attempt — after this, they will be asked to enter measurements
manually. You must do your absolute best to return something useful from this image.

OVERRIDING RULE: You MUST NOT return "usable": false on this attempt under any
circumstances. The usable: false path is disabled for this second attempt.

If the image is perfectly clear → proceed with full zone detection as normal.

If the image is still unclear, blurry, partially obscured, or otherwise difficult:
  → Set "usable": true regardless of image quality.
  → Include "main_walls" as your best possible estimate of the exterior wall area:
      • If any facade surface is partially visible: estimate from what you can see.
      • If the facade dimensions cannot be inferred at all: use 400.0 sqft as a
        conservative placeholder — typical for a single-storey residential front face.
  → Include "gate_grille" with count: 1 ONLY if any gate structure is faintly visible.
  → Do NOT include other zones unless you have reasonable confidence they are present.
  → Set confidence between 0.30 and 0.50 for all estimates made in fallback mode.
  → The confidence 0.30 minimum-exclusion rule from Step D is SUSPENDED for this
    attempt: every zone you include must stay at or above 0.30.
  → Do NOT include zones at confidence below 0.30 — if you cannot estimate a zone
    even roughly, simply omit it.

The user will see these values on the next screen and can adjust all measurements
manually before continuing. A rough estimate with low confidence is far more helpful
to them than a usable: false response that blocks their progress entirely.
"""


# Hardcoded safety-net zones — inserted by the backend ONLY when the AI ignores the
# mandatory fallback instructions above and still returns usable: false on attempt 2.
# This ensures the user always reaches the HITL screen with at least one zone to edit.
FALLBACK_ZONES = [
    {
        "zone_type": "main_walls",
        "measurement_value": 400.0,
        "measurement_unit": "sqft",
        "ai_detected": False,
    },
]


def build_detection_prompt(house_width: Optional[float], attempt_number: int = 1) -> str:
    """
    Build the full detection prompt.

    Injects user-provided house width as the primary scale reference.
    On attempt_number >= 2, appends mandatory fallback instructions that
    prevent the model from returning usable: false a second time.
    """
    if house_width and house_width > 0:
        width_context = (
            f"USER-PROVIDED METADATA:\n"
            f"  House width: {house_width} feet (provided by the user)\n"
            f"  Use this as your PRIMARY scale reference for all horizontal measurements.\n"
            f"  Cross-validate against visible references (door, window) when possible."
        )
    else:
        width_context = (
            "USER-PROVIDED METADATA:\n"
            "  House width: not provided\n"
            "  Use visual references in the image for scale (see Step A below)."
        )
    prompt = _DETECTION_PROMPT_BASE.replace("__HOUSE_WIDTH_CONTEXT__", width_context)
    if attempt_number >= 2:
        prompt += _RETRY_FALLBACK_SECTION
    return prompt


# ─── MAIN SERVICE FUNCTION ────────────────────────────────────────────────────

# Backend-level zone validation schema.
# Defines the ONLY valid zone types, their required measurement unit, and value type.
# Any zone returned by Gemini that violates any of these is silently dropped with a warning.
# This prevents DB enum errors, type mismatches, and corrupt measurement data.
_ZONE_SCHEMA: dict = {
    "main_walls":         {"unit": "sqft",      "count": False},
    "columns_pillars":    {"unit": "sqft",      "count": False},
    "parapet_wall":       {"unit": "sqft",      "count": False},
    "balcony_floor":      {"unit": "sqft",      "count": False},
    "gate_boundary_wall": {"unit": "sqft",      "count": False},
    "balcony_railing":    {"unit": "linear_ft", "count": False},
    "roof_edge_railing":  {"unit": "linear_ft", "count": False},
    "gate_grille":        {"unit": "count",     "count": True},
}

_VALID_ZONE_TYPES = set(_ZONE_SCHEMA.keys())


def _validate_zone(z: dict) -> tuple[bool, str]:
    """
    Validate a single zone dict returned by Gemini.
    Returns (is_valid, reason_if_invalid).
    Checks: zone_type, measurement_unit, measurement_value, confidence.
    """
    zone_type = z.get("zone_type")
    if zone_type not in _ZONE_SCHEMA:
        return False, f"unknown zone_type '{zone_type}'"

    schema = _ZONE_SCHEMA[zone_type]

    # Unit must match exactly
    unit = z.get("measurement_unit")
    if unit != schema["unit"]:
        return False, f"{zone_type}: expected unit '{schema['unit']}', got '{unit}'"

    # Value must be a positive number
    value = z.get("measurement_value")
    if value is None or not isinstance(value, (int, float)) or value <= 0:
        return False, f"{zone_type}: invalid measurement_value '{value}'"

    # Count zones must be a whole number
    if schema["count"] and not float(value).is_integer():
        return False, f"{zone_type}: count must be an integer, got '{value}'"

    # Confidence must be 0.0–1.0
    confidence = z.get("confidence")
    if confidence is None or not isinstance(confidence, (int, float)):
        return False, f"{zone_type}: missing or non-numeric confidence '{confidence}'"
    if not (0.0 <= float(confidence) <= 1.0):
        return False, f"{zone_type}: confidence out of range '{confidence}'"

    return True, ""


def _deduct_credit(db, user_id: str, project_id: str, reason: str) -> None:
    """Deduct 1 credit from user and log to credit_transactions. Called after successful AI call."""
    fresh = db.table("users").select("credits").eq("id", user_id).execute().data
    if fresh:
        db.table("users").update({"credits": max(0, fresh[0]["credits"] - 1)}).eq("id", user_id).execute()
    db.table("credit_transactions").insert({
        "user_id": user_id,
        "project_id": project_id,
        "delta": -1,
        "reason": reason,
    }).execute()


def run_detection(
    project_id: str,
    image_path: str,
    house_width: Optional[float] = None,
    attempt_number: int = 1,
    user_id: str = "",
) -> None:
    """
    Background task — runs after upload.

    Status outcomes:
      usable=True  + zones        → saves zones → status='hitl'
      usable=False, attempt 1     → saves reason → status='pending' (user re-uploads)
      usable=False, attempt >= 2  → inserts FALLBACK_ZONES → status='hitl'
                                    (AI ignored mandatory fallback instructions —
                                     backend safety-net so user is never blocked)
      exception                   → status='failed' (system/API error)
    """
    db = get_db()
    logger.info("Detection started — project_id=%s attempt=%d", project_id, attempt_number)

    try:
        result: DetectionResult = _call_vision_model(image_path, house_width, attempt_number)
        logger.info(
            "AI response — project_id=%s usable=%s zones=%d",
            project_id, result.usable, len(result.zones),
        )

        if not result.usable:
            if attempt_number >= 2:
                # AI ignored the mandatory fallback instructions in _RETRY_FALLBACK_SECTION.
                # Safety-net: insert hardcoded defaults so the user reaches the HITL screen.
                logger.warning(
                    "AI returned usable=False on attempt 2 — applying backend fallback zones. project_id=%s",
                    project_id,
                )
                db.table("zones").delete().eq("project_id", project_id).execute()
                rows = [{"project_id": project_id, **z} for z in FALLBACK_ZONES]
                db.table("zones").insert(rows).execute()
                db.table("projects").update({
                    "status": "hitl",
                    "ai_raw_response": {
                        "unusable_reason": result.unusable_reason,
                        "fallback_used": True,
                        "raw": result.raw_response,
                    },
                }).eq("id", project_id).execute()
            else:
                # First attempt — let user try a better photo
                logger.info(
                    "Image unusable (attempt 1) — project_id=%s reason=%s",
                    project_id, result.unusable_reason,
                )
                db.table("projects").update({
                    "status": "pending",
                    "ai_raw_response": {
                        "unusable_reason": result.unusable_reason,
                        "raw": result.raw_response,
                    },
                }).eq("id", project_id).execute()
            return

        # Save detected zones
        rows = [
            {
                "project_id": project_id,
                "zone_type": z.zone_type,
                "measurement_value": z.measurement_value,
                "measurement_unit": z.measurement_unit,
                "ai_detected": True,
            }
            for z in result.zones
        ]
        if rows:
            db.table("zones").insert(rows).execute()

        db.table("projects").update({
            "status": "hitl",
            "ai_raw_response": result.raw_response,
        }).eq("id", project_id).execute()
        logger.info(
            "Detection complete — project_id=%s zones=%d status=hitl",
            project_id, len(rows),
        )

    except Exception as e:
        # Genuine system/API error
        logger.exception("Detection failed — project_id=%s error=%s", project_id, e)
        db.table("projects").update({
            "status": "failed",
            "ai_raw_response": {"error": str(e)},
        }).eq("id", project_id).execute()
        raise


# ─── MODEL CALL ───────────────────────────────────────────────────────────────

def _call_vision_model(
    image_path: str,
    house_width: Optional[float] = None,
    attempt_number: int = 1,
) -> DetectionResult:
    """
    Send image + detection prompt to vision model and parse the response.

    ── HOW TO IMPLEMENT WHEN MODEL IS DECIDED ──────────────────────────────
    1. Read and encode image:
         with open(image_path, "rb") as f:
             image_b64 = base64.b64encode(f.read()).decode()

    2. Build prompt (pass attempt_number — injects fallback section on attempt 2+):
         prompt = build_detection_prompt(house_width, attempt_number)

    3. Call model API:
         - Pass prompt as user/system message
         - Attach image as base64 JPEG
         - Temperature: 0 (deterministic — not creative)
         - Max output tokens: 1500

    4. Extract text response from model output (exact path varies by SDK).

    5. Parse JSON:
         parsed = json.loads(raw_text)

    6. Build and return:
         return DetectionResult(
             usable=parsed["usable"],
             unusable_reason=parsed.get("unusable_reason"),
             zones=[
                 DetectedZone(
                     zone_type=z["zone_type"],
                     measurement_value=z["measurement_value"],
                     measurement_unit=z["measurement_unit"],
                     confidence=z["confidence"],
                 )
                 for z in parsed.get("zones", [])
             ],
             raw_response=parsed,
         )
    ─────────────────────────────────────────────────────────────────────────

    Real implementation — calls Gemini Vision with the house photo.
    Model config: GEMINI_VISION_MODEL=gemini-2.5-flash in .env.
    Temperature 0 for deterministic JSON output.
    """
    from google import genai as google_genai
    from google.genai import types
    from app.config import settings

    client = google_genai.Client(api_key=settings.GEMINI_API_KEY)

    # ── Read image bytes (supports Supabase URL or local path) ──────────────
    image_bytes = read_image_bytes(image_path)

    # ── Build prompt (injects fallback section on attempt 2+) ────────────────
    prompt = build_detection_prompt(house_width, attempt_number)

    # ── Call Gemini Vision ───────────────────────────────────────────────────
    response = client.models.generate_content(
        model=settings.GEMINI_VISION_MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            types.Part.from_text(text=prompt),
        ],
        config=types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=8192,
        ),
    )

    raw_text = response.text
    if not raw_text:
        raise ValueError("Gemini returned an empty response for zone detection")

    logger.debug("Gemini raw response: %s", raw_text)

    # ── Extract and clean JSON robustly ─────────────────────────────────────
    # Gemini may: add text before/after the JSON, wrap in markdown fences,
    # include // comments, trailing commas, or single quotes.
    stripped = raw_text.strip()

    # 1. Pull out the outermost { } block — drops any preamble/postamble
    json_start = stripped.find("{")
    json_end = stripped.rfind("}") + 1
    if json_start == -1 or json_end == 0:
        raise ValueError(f"No JSON object found in Gemini response: {stripped[:300]}")
    stripped = stripped[json_start:json_end]

    # 2. Remove // line comments (invalid in JSON)
    import re
    stripped = re.sub(r"//[^\n]*", "", stripped)

    # 3. Remove trailing commas before } or ] (invalid in JSON)
    stripped = re.sub(r",\s*([}\]])", r"\1", stripped)

    parsed = json.loads(stripped)

    # ── Validate every zone against the schema ───────────────────────────────
    # Checks: zone_type in defined list, correct unit per zone, positive value,
    # integer value for count zones, confidence in 0.0–1.0 range.
    valid_zones = []
    for z in parsed.get("zones", []):
        ok, reason = _validate_zone(z)
        if ok:
            valid_zones.append(z)
        else:
            logger.warning("Dropped invalid zone from AI response: %s", reason)

    return DetectionResult(
        usable=parsed["usable"],
        unusable_reason=parsed.get("unusable_reason"),
        zones=[
            DetectedZone(
                zone_type=z["zone_type"],
                measurement_value=z["measurement_value"],
                measurement_unit=z["measurement_unit"],
                confidence=z["confidence"],
            )
            for z in valid_zones
        ],
        raw_response=parsed,
    )
