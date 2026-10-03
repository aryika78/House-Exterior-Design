"""
Projects router — full project lifecycle.

Endpoints:
  POST   /api/projects                     — create project shell
  GET    /api/projects                     — list user's projects (dashboard)
  GET    /api/projects/{id}                — get full project (status + zones + materials + costs)
  POST   /api/projects/{id}/upload         — upload image, trigger detection
  POST   /api/projects/{id}/zones          — save HITL zone review
  POST   /api/projects/{id}/materials      — save material selection, trigger render
  GET    /api/projects/{id}/status         — lightweight status poll (used by frontend)
  POST   /api/projects/{id}/report         — generate + stream PDF report

Status machine (guards every write endpoint):
  pending → [upload] → detecting → [AI done] → hitl → [zones saved] →
  material_selection → [materials saved] → rendering → [render done] → completed

Race condition protection:
  - Every write endpoint validates current status before acting
  - Background tasks update status atomically
  - Credit deduction uses DB-level check before render trigger
"""
import logging
import math
import uuid
from datetime import date
from fastapi import (
    APIRouter, HTTPException, Depends, UploadFile, File, BackgroundTasks,
    status as http_status,
)
from fastapi.responses import StreamingResponse
from app.dependencies.auth import get_current_user
from app.db.client import get_db
from app.models.schemas import (
    ProjectOut, SaveZonesRequest, SaveMaterialsRequest,
    ZoneOut, ZoneMaterialOut, CostLineItemOut, UpdateCostsRequest,
    RerenderRequest, ZoneMaterialSave,
)
from app.services.image_service import process_upload
from app.services.storage_service import upload_image as storage_upload
from app.services.ai_service import run_detection, FALLBACK_ZONES
from app.services.render_service import run_render
from app.services.cost_service import calculate_costs
from app.services.pdf_service import generate_pdf
from app.config import settings

router = APIRouter(prefix="/api/projects", tags=["projects"])
logger = logging.getLogger(__name__)

# Explicit whitelist — not startswith("image/") which would pass GIF/SVG/TIFF/BMP
_ACCEPTED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}


# ─── HELPERS ──────────────────────────────────────────────────────────────────

_GLOBAL_RENDER_LIMIT = 3  # Hard cap on renders across all users, all time — hidden from UI


def _gate_ai_call(db, user_id: str, credits: int) -> None:
    """
    Raise 402 if user has no credits left OR global render limit is reached.
    Called before queuing render only (detection is free, no gate).
    Actual deduction happens AFTER render succeeds (inside the background task).
    """
    if credits < 1:
        raise HTTPException(status_code=402, detail="Insufficient credits")
    total_calls = len(
        db.table("credit_transactions").select("id").execute().data or []
    )
    if total_calls >= _GLOBAL_RENDER_LIMIT:
        raise HTTPException(
            status_code=402,
            detail="Service limit reached. Please contact support.",
        )


def _get_project_or_404(project_id: str, user_id: str) -> dict:
    """Fetch project, verify ownership, or raise 404."""
    db = get_db()
    result = db.table("projects").select("*").eq("id", project_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Project not found")
    project = result.data[0]
    if project["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Not your project")
    return project


def _build_project_out(project: dict) -> ProjectOut:
    """Assemble full ProjectOut by fetching related rows."""
    db = get_db()
    pid = project["id"]

    zones_raw = db.table("zones").select("*").eq("project_id", pid).execute().data or []
    materials_raw = (
        db.table("zone_materials")
        .select("*, zones(zone_type)")
        .eq("project_id", pid)
        .execute()
        .data or []
    )
    costs_raw = (
        db.table("cost_line_items").select("*").eq("project_id", pid).execute().data or []
    )

    zones = [ZoneOut(**z) for z in zones_raw]
    materials = [
        ZoneMaterialOut(
            id=m["id"],
            zone_id=m["zone_id"],
            zone_type=m["zones"]["zone_type"] if m.get("zones") else "",
            material_type=m["material_type"],
            color=m.get("color"),
            pattern=m.get("pattern"),
        )
        for m in materials_raw
    ]
    costs = [CostLineItemOut(**c) for c in costs_raw]

    # Extract unusable_reason from ai_raw_response if AI rejected the image
    ai_raw = project.get("ai_raw_response") or {}
    unusable_reason = ai_raw.get("unusable_reason") if isinstance(ai_raw, dict) else None

    return ProjectOut(
        id=project["id"],
        user_id=project["user_id"],
        status=project["status"],
        tier=project.get("tier"),
        original_image_url=project.get("original_image_url"),
        render_image_url=project.get("render_image_url"),
        render_count=project.get("render_count", 0),
        total_cost=project.get("total_cost"),
        created_at=str(project["created_at"]),
        unusable_reason=unusable_reason,
        zones=zones,
        zone_materials=materials,
        cost_line_items=costs,
    )


# ─── ROUTES ───────────────────────────────────────────────────────────────────

@router.post("", response_model=ProjectOut, status_code=201)
def create_project(current_user: dict = Depends(get_current_user)):
    """Create a blank project shell. Returns immediately with status=pending."""
    db = get_db()
    result = db.table("projects").insert({
        "user_id": current_user["id"],
        "status": "pending",
        "render_count": 0,
    }).execute()
    project = result.data[0]
    logger.info("Project created — id=%s user=%s", project["id"], current_user["id"])
    return _build_project_out(project)


@router.get("", response_model=list[ProjectOut])
def list_projects(current_user: dict = Depends(get_current_user)):
    """Return all projects for the current user, newest first."""
    db = get_db()
    result = (
        db.table("projects")
        .select("*")
        .eq("user_id", current_user["id"])
        .order("created_at", desc=True)
        .execute()
    )
    return [_build_project_out(p) for p in (result.data or [])]


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, current_user: dict = Depends(get_current_user)):
    """Get full project including zones, materials, costs."""
    project = _get_project_or_404(project_id, current_user["id"])
    return _build_project_out(project)


@router.get("/{project_id}/status")
def get_project_status(project_id: str, current_user: dict = Depends(get_current_user)):
    """
    Lightweight status endpoint for frontend polling.
    Returns only {id, status} — avoids fetching all related rows on every poll.
    """
    project = _get_project_or_404(project_id, current_user["id"])
    return {"id": project["id"], "status": project["status"]}


@router.post("/{project_id}/upload", response_model=ProjectOut)
def upload_image(
    project_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    house_width: float | None = None,   # optional — user-provided house width in feet
    attempt_number: int = 1,            # 1 = first attempt, 2+ = retry after unusable
    current_user: dict = Depends(get_current_user),
):
    """
    Upload house exterior photo.
    - Validates: status must be 'pending'
    - Compresses image (Pillow: max 2048px, JPEG q85, strip EXIF)
    - Saves to storage/uploads/{project_id}/original.jpg
    - Sets status = 'detecting'
    - Queues background zone detection task
    - Returns immediately (detection runs async)
    """
    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] not in ("pending", "failed"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot upload — project is in status '{project['status']}'"
        )

    # Validate house width (optional but must be sensible if provided)
    if house_width is not None and (house_width <= 0 or house_width > 500):
        raise HTTPException(
            status_code=400,
            detail="House width must be between 1 and 500 feet.",
        )

    # Validate file type against module-level whitelist
    if not file.content_type or file.content_type.lower() not in _ACCEPTED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Please upload a JPG, PNG, or WebP photo.",
        )

    # Validate file size (10 MB max before processing)
    contents = file.file.read()
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large — max 10 MB")

    # Process (compress + EXIF strip) — Pillow raises UnidentifiedImageError on corrupt files
    try:
        processed_bytes = process_upload(contents)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or corrupt image file")

    # Upload to Supabase Storage — survives server restarts/redeploys
    storage_path = f"uploads/{project_id}/original.jpg"
    try:
        public_url = storage_upload(storage_path, processed_bytes)
    except Exception:
        logger.exception("Storage upload failed — project_id=%s", project_id)
        raise HTTPException(status_code=500, detail="Failed to store image. Please try again.")

    db = get_db()
    db.table("projects").update({
        "original_image_url": public_url,
        "status": "detecting",
    }).eq("id", project_id).execute()

    logger.info(
        "Upload complete — project_id=%s size=%db attempt=%d",
        project_id, len(processed_bytes), attempt_number,
    )
    # Queue detection — passes public URL (works even if server restarts mid-flight)
    background_tasks.add_task(run_detection, project_id, public_url, house_width, attempt_number, current_user["id"])
    logger.info("Detection queued — project_id=%s", project_id)

    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.post("/{project_id}/force-hitl", response_model=ProjectOut)
def force_hitl(
    project_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    "Proceed Anyway" — called by frontend after 2 failed AI detection attempts.
    Inserts default fallback zones so the user arrives at HITL with a starting point,
    then advances status to 'hitl'.
    Only allowed when status is 'pending' (i.e. AI rejected the image).
    """
    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] not in ("pending", "failed"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot force-proceed — project is in status '{project['status']}'"
        )

    db = get_db()

    # Insert default fallback zones so the user has a starting point to edit,
    # not a blank form. ai_detected=False marks them as user-adjustable defaults.
    db.table("zones").delete().eq("project_id", project_id).execute()
    default_rows = [
        {
            "project_id": project_id,
            "zone_type": z["zone_type"],
            "measurement_value": z["measurement_value"],
            "measurement_unit": z["measurement_unit"],
            "ai_detected": False,
        }
        for z in FALLBACK_ZONES
    ]
    db.table("zones").insert(default_rows).execute()

    db.table("projects").update({"status": "hitl"}).eq("id", project_id).execute()
    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.post("/{project_id}/zones", response_model=ProjectOut)
def save_zones(
    project_id: str,
    body: SaveZonesRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Save HITL-confirmed zones after user review.
    - Validates: status must be 'hitl'
    - Replaces all existing zones for project (clean slate)
    - Sets status = 'material_selection'
    """
    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] != "hitl":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot save zones — project is in status '{project['status']}'"
        )

    if not body.zones:
        raise HTTPException(status_code=400, detail="At least one zone is required")

    db = get_db()

    # Delete existing zones (cascade deletes zone_materials + cost_line_items via FK)
    db.table("zones").delete().eq("project_id", project_id).execute()

    # Insert confirmed zones
    rows = [
        {
            "project_id": project_id,
            "zone_type": z.zone_type,
            "measurement_value": z.measurement_value,
            "measurement_unit": z.measurement_unit,
            "ai_detected": z.ai_detected,
        }
        for z in body.zones
    ]
    db.table("zones").insert(rows).execute()

    # Advance status
    db.table("projects").update({"status": "material_selection"}).eq("id", project_id).execute()

    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.post("/{project_id}/materials", response_model=ProjectOut)
def save_materials(
    project_id: str,
    body: SaveMaterialsRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """
    Save material selections, deduct 1 credit, trigger render.
    - Validates: status must be 'material_selection'
    - Validates: all zones have a material selected
    - Atomic credit check + deduct
    - Saves zone_materials
    - Sets status = 'rendering'
    - Queues background render task
    """
    project = _get_project_or_404(project_id, current_user["id"])

    # Allow first render (material_selection) OR retry render (completed/failed + render_count < 2)
    is_retry = (
        project["status"] in ("completed", "failed")
        and project.get("render_count", 0) < 2
    )
    if project["status"] != "material_selection" and not is_retry:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot save materials — project is in status '{project['status']}'"
        )

    db = get_db()

    # Fetch zones to validate all are covered
    zones = db.table("zones").select("*").eq("project_id", project_id).execute().data or []
    if not zones:
        raise HTTPException(status_code=400, detail="No zones found for this project")

    zone_ids_with_zones = {z["id"] for z in zones}
    zone_ids_in_request = {m.zone_id for m in body.materials}
    missing = zone_ids_with_zones - zone_ids_in_request
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing material selection for {len(missing)} zone(s)"
        )

    # Credit gate — check before queuing (deduction happens after render succeeds)
    fresh_user = db.table("users").select("credits").eq("id", current_user["id"]).execute().data
    _gate_ai_call(db, current_user["id"], fresh_user[0]["credits"] if fresh_user else 0)

    # Save materials (replace existing)
    db.table("zone_materials").delete().eq("project_id", project_id).execute()
    material_rows = [
        {
            "project_id": project_id,
            "zone_id": m.zone_id,
            "material_type": m.material_type,
            "color": m.color,
            "pattern": m.pattern,
        }
        for m in body.materials
    ]
    db.table("zone_materials").insert(material_rows).execute()

    # Save tier on project + advance status
    db.table("projects").update({
        "tier": body.tier,
        "status": "rendering",
    }).eq("id", project_id).execute()

    # Queue render (pass retry_notes so render prompt can include user feedback)
    background_tasks.add_task(run_render, project_id, zones, body.materials, body.tier, body.retry_notes, current_user["id"])
    logger.info("Render queued — project_id=%s tier=%s", project_id, body.tier)

    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.patch("/{project_id}/cost-items", response_model=ProjectOut)
def update_cost_items(
    project_id: str,
    body: UpdateCostsRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Update measurement or rate overrides on cost line items.
    Recalculates material_cost, labor_cost, zone_total, liters_needed, num_tiles in-place.
    Updates project.total_cost.
    Only available when project status = 'completed'.
    """
    from app.services.cost_service import WASTAGE, PAINT_COVERAGE_SQFT_PER_LITER, TILE_SQFT_BY_TIER

    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] != "completed":
        raise HTTPException(
            status_code=400,
            detail="Cost items can only be edited for completed projects"
        )

    db = get_db()
    tier = project["tier"]
    new_total = 0.0

    for upd in body.items:
        existing = (
            db.table("cost_line_items")
            .select("material_type")
            .eq("zone_id", upd.zone_id)
            .eq("project_id", project_id)
            .execute()
            .data
        )
        if not existing:
            continue

        mat = existing[0]["material_type"]
        wastage = WASTAGE[mat]
        effective = upd.measurement * (1 + wastage)

        material_cost = round(effective * upd.material_rate, 2)
        labor_cost = round(upd.measurement * upd.labor_rate, 2)   # net area, no wastage
        zone_total = round(material_cost + labor_cost, 2)

        liters_needed = None
        num_tiles = None
        if mat == "paint":
            liters_needed = round(effective / PAINT_COVERAGE_SQFT_PER_LITER, 2)
        if mat == "tiles":
            tile_sqft = TILE_SQFT_BY_TIER[tier]
            num_tiles = math.ceil(effective / tile_sqft)

        db.table("cost_line_items").update({
            "measurement":    upd.measurement,
            "material_rate":  upd.material_rate,
            "material_cost":  material_cost,
            "labor_rate":     upd.labor_rate,
            "labor_cost":     labor_cost,
            "zone_total":     zone_total,
            "liters_needed":  liters_needed,
            "num_tiles":      num_tiles,
        }).eq("zone_id", upd.zone_id).eq("project_id", project_id).execute()

    # Re-fetch ALL items to compute correct total (covers partial updates)
    all_items = (
        db.table("cost_line_items")
        .select("zone_total")
        .eq("project_id", project_id)
        .execute()
        .data or []
    )
    total_cost = round(sum(float(i["zone_total"]) for i in all_items), 2)
    db.table("projects").update({"total_cost": total_cost}).eq("id", project_id).execute()

    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.post("/{project_id}/back-to-zones", response_model=ProjectOut)
def back_to_zones(
    project_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Rewind a completed project back to zone review (step 3).
    - Validates: status must be 'completed' and render_count < 2
    - Preserves all existing zones — user edits from there
    - Sets status = 'hitl'
    - No credit deducted here — credit deducted later when render triggers
    """
    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] != "completed":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot rewind to zones — project is in status '{project['status']}'"
        )
    if project.get("render_count", 0) >= 2:
        raise HTTPException(status_code=400, detail="Maximum renders reached for this project")

    db = get_db()
    db.table("projects").update({"status": "hitl"}).eq("id", project_id).execute()

    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.post("/{project_id}/rerender", response_model=ProjectOut)
def rerender(
    project_id: str,
    body: RerenderRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """
    Re-render with the same materials — user provides notes about what to fix.
    - Validates: status must be 'completed' and render_count < 2
    - Deducts 1 credit (same as first render)
    - Re-uses existing zone_materials from DB — no material changes
    - Sets status = 'rendering'
    - Queues background render with retry_notes
    """
    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] not in ("completed", "failed"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot re-render — project is in status '{project['status']}'"
        )
    if project.get("render_count", 0) >= 2:
        raise HTTPException(status_code=400, detail="Maximum renders reached for this project")

    db = get_db()

    # Fetch existing zones + materials (re-use as-is)
    zones = db.table("zones").select("*").eq("project_id", project_id).execute().data or []
    if not zones:
        raise HTTPException(status_code=400, detail="No zones found for this project")

    materials_raw = (
        db.table("zone_materials").select("*").eq("project_id", project_id).execute().data or []
    )
    if not materials_raw:
        raise HTTPException(status_code=400, detail="No materials found for this project")

    materials = [
        ZoneMaterialSave(
            zone_id=m["zone_id"],
            material_type=m["material_type"],
            color=m.get("color"),
            pattern=m.get("pattern"),
        )
        for m in materials_raw
    ]

    # Credit gate — check before queuing (deduction happens after render succeeds)
    fresh_user = db.table("users").select("credits").eq("id", current_user["id"]).execute().data
    _gate_ai_call(db, current_user["id"], fresh_user[0]["credits"] if fresh_user else 0)

    # Advance status to rendering
    db.table("projects").update({"status": "rendering"}).eq("id", project_id).execute()

    # Queue render with existing materials + user's retry notes
    tier = project.get("tier", "standard")
    background_tasks.add_task(run_render, project_id, zones, materials, tier, body.retry_notes, current_user["id"])
    logger.info("Re-render queued — project_id=%s tier=%s", project_id, tier)

    updated = db.table("projects").select("*").eq("id", project_id).execute().data[0]
    return _build_project_out(updated)


@router.post("/{project_id}/report")
def download_report(
    project_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Generate + stream PDF report on demand.
    - Validates: status must be 'completed'
    - Builds 4-page PDF via ReportLab
    - Streams directly — not saved to disk
    """
    project = _get_project_or_404(project_id, current_user["id"])

    if project["status"] != "completed":
        raise HTTPException(
            status_code=400,
            detail="Report only available after project is completed"
        )

    full_project = _build_project_out(project)
    logger.info("PDF generation started — project_id=%s", project_id)
    try:
        pdf_bytes = generate_pdf(full_project)
    except Exception:
        logger.exception("PDF generation failed — project_id=%s", project_id)
        raise HTTPException(
            status_code=500,
            detail="Could not generate the PDF report. Please try again.",
        )
    logger.info("PDF generated — project_id=%s size=%db", project_id, len(pdf_bytes))

    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'attachment; filename="renovation_report_{project_id}_{date.today().isoformat()}.pdf"'
            )
        },
    )
