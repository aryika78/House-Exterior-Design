"""
Render Service — Gemini image-in → image-out renovation render.

Contract:
  Input : project_id, zones, zone_materials, tier
  Output: saves render image, triggers cost calculation, sets status='completed'
          On error: sets status='failed'

Background task called from: projects.py → save_materials endpoint

Model: GEMINI_MODEL in .env — set to "gemini-3.1-flash-image"
"""
import base64
import io
import logging
from typing import List, Optional

from PIL import Image

from app.config import settings
from app.db.client import get_db
from app.models.schemas import Tier, ZoneMaterialSave
from app.services.cost_service import calculate_costs
from app.services.storage_service import upload_image, read_image_bytes

logger = logging.getLogger(__name__)


# ─── ZONE LOCATION DESCRIPTIONS ───────────────────────────────────────────────
# Tells the AI exactly WHERE on the house each zone is located.
# Critical: the AI must apply the correct material to the correct surface.

_ZONE_LOCATION: dict = {
    "main_walls": (
        "MAIN WALLS — the large primary plastered/masonry wall surfaces forming "
        "the main body of the building facade, spanning full floor-to-floor height. "
        "This is the dominant background surface of the house exterior."
    ),
    "columns_pillars": (
        "COLUMNS / PILLARS — the vertical protrusions raised outward from the main "
        "wall surface. Located at building corners, entrance portico, or spaced along "
        "the facade. Cylindrical or square/rectangular in cross-section. These are "
        "distinctly raised from the flat wall behind them."
    ),
    "parapet_wall": (
        "PARAPET WALL — the solid masonry horizontal band running along the very top "
        "roofline edge of the building (present only on flat-roofed buildings). "
        "Typically 3–4 ft tall, runs the full visible width of the roofline. "
        "It is solid/opaque — you cannot see through it."
    ),
    "balcony_floor": (
        "BALCONY FLOOR — the horizontal floor surface of the balcony platform "
        "projecting outward from the building. Seen from the front as a horizontal "
        "surface. Apply the material to this floor area only."
    ),
    "balcony_railing": (
        "BALCONY RAILING — the barrier/railing running along the open outer edge of "
        "the balcony platform. Typically 3–3.5 ft tall. Replaces the existing "
        "railing/parapet structure along the balcony edge completely."
    ),
    "gate_grille": (
        "ENTRANCE GATE — the main entrance gate structure at the property boundary, "
        "visible in the foreground of the image. Replaces the existing gate entirely "
        "with the specified new gate type."
    ),
    "gate_boundary_wall": (
        "BOUNDARY WALL — the compound/perimeter wall running along the property "
        "boundary, separate from the main building. Lower than the main building "
        "(typically 5–6 ft), located in the foreground. Apply material to its "
        "visible surface area."
    ),
    "roof_edge_railing": (
        "ROOF EDGE RAILING — the open (see-through) railing/balustrade structure "
        "running along the top roof edge of the building. Distinguished from the "
        "parapet wall by being open — you can partially see through it. Located at "
        "the very top of the building."
    ),
}


# ─── MATERIAL VISUAL DESCRIPTIONS ─────────────────────────────────────────────
# For each material × tier, a precise visual description.
# paint and texture_finish use {color} placeholder (filled at runtime with hex).
# texture_finish also uses {pattern_desc} (filled from _TEXTURE_PATTERNS).
# All other materials: tier fully determines the visual appearance.

_MATERIAL_VISUAL: dict = {

    "paint": {
        # Smooth coating, appearance changes by tier sheen level.
        # Color is user-selected hex — must be applied exactly.
        "economy": (
            "PAINT — Economy tier: Basic acrylic exterior emulsion, MATTE flat finish. "
            "Slightly chalky surface with no reflectivity. Even color coverage with minor "
            "roller/brush texture visible up close. "
            "Apply color {color} uniformly across the entire zone surface."
        ),
        "standard": (
            "PAINT — Standard tier: Premium acrylic exterior emulsion, SATIN finish. "
            "Smooth even surface with a gentle, low sheen — not glossy, just slightly "
            "reflective in direct light. Clean, well-applied appearance. "
            "Apply color {color} uniformly across the entire zone surface."
        ),
        "premium": (
            "PAINT — Premium tier: High-end weatherproof exterior emulsion, SOFT GLOSS "
            "finish. Rich color depth, slight mirror-like reflectivity in bright light. "
            "Perfectly smooth application with no visible brush or roller marks. "
            "Apply color {color} uniformly across the entire zone surface."
        ),
    },

    "stone_cladding": {
        # Stone type changes completely per tier — Kota → Sandstone → Granite.
        # No user color selection — the stone's natural color is inherent.
        "economy": (
            "STONE CLADDING — Economy tier: KOTA STONE / SLATE. "
            "Dark grey to grey-green natural stone with a rough, uneven cleft surface "
            "texture. Small to medium format irregular slabs (approximately 12×18 inches "
            "to 18×24 inches). Laid in a horizontal coursing pattern with grey cement "
            "grout lines (10–15mm wide). Completely MATTE — no polish or shine. "
            "Natural color variation across slabs: some patches darker grey-green, "
            "some lighter. The surface looks raw, earthy, and textured."
        ),
        "standard": (
            "STONE CLADDING — Standard tier: SANDSTONE. "
            "Warm beige, honey-tan, or buff-yellow natural stone. Medium rough texture "
            "with visible horizontal grain lines running across each slab. Regular "
            "medium-format slabs (18×18 inches or 12×24 inches). Horizontal stack bond "
            "coursing. Grey grout lines (6–10mm). MATTE finish. Warmer, lighter in "
            "tone compared to Kota stone — golden-beige appearance in sunlight."
        ),
        "premium": (
            "STONE CLADDING — Premium tier: POLISHED GRANITE. "
            "Deep grey, charcoal, or near-black natural stone. Smooth, highly POLISHED "
            "mirror-like surface — reflects light and shows a blurry reflection of the "
            "environment. Large format slabs (24×24 inches or larger). Very thin "
            "precision grout lines (2–4mm, barely visible). Subtle crystalline sparkle "
            "specks visible within the stone in sunlight. Luxurious, high-end appearance."
        ),
    },

    "texture_finish": {
        # Pattern type describes the surface relief shape.
        # Tier controls relief depth (how pronounced the texture is).
        # Color is user-selected hex.
        "economy": (
            "TEXTURE FINISH — Economy tier: Thin acrylic texture coat. "
            "Pattern: {pattern_desc}. "
            "Relief depth is SUBTLE — approximately 1–2mm. Shadow lines between "
            "texture elements are faint and delicate. Up close the texture is visible; "
            "from distance it appears as a slightly rough surface. "
            "Apply color {color} uniformly — the texture relief creates natural "
            "light-and-shadow variation within that base color."
        ),
        "standard": (
            "TEXTURE FINISH — Standard tier: Medium acrylic texture coat. "
            "Pattern: {pattern_desc}. "
            "Relief depth is MODERATE — approximately 3–4mm. Clear, well-defined "
            "shadow lines between texture elements. The texture pattern is clearly "
            "readable from a normal viewing distance. "
            "Apply color {color} uniformly — shadow in the relief creates visible "
            "tonal variation within that base color."
        ),
        "premium": (
            "TEXTURE FINISH — Premium tier: Heavy polymer texture coat. "
            "Pattern: {pattern_desc}. "
            "Relief depth is DRAMATIC — approximately 5–7mm. Strong deep shadows cast "
            "within the texture pattern. The texture is bold and visually prominent, "
            "visible from across the street. "
            "Apply color {color} uniformly — the deep relief creates rich tonal contrast "
            "and depth within that base color."
        ),
    },

    "tiles": {
        # Tile format and finish change per tier.
        # No user color selection — tier determines the appearance.
        "economy": (
            "TILES — Economy tier: Standard CERAMIC tiles. "
            "Small format: approximately 300×300mm or 400×400mm. "
            "Basic off-white, cream, or light grey tones. MATTE finish — no shine. "
            "Visible grey grout grid lines forming a regular square grid pattern. "
            "Grout lines approximately 8–10mm wide. Slightly utilitarian appearance."
        ),
        "standard": (
            "TILES — Standard tier: VITRIFIED tiles. "
            "Medium-large format: 600×600mm. "
            "Modern neutral tones — light grey, warm grey, off-white, or cream. "
            "SEMI-GLOSS finish with gentle reflectivity. "
            "Thin grout lines approximately 3–5mm. Clean, contemporary appearance "
            "with precise rectangular grid. More refined and modern than ceramic."
        ),
        "premium": (
            "TILES — Premium tier: Large format GVT / PORCELAIN tiles. "
            "Large format: 600×1200mm or 800×800mm. "
            "HIGH-GLOSS to MIRROR finish — strong reflectivity, reflects light sharply. "
            "Near-white, light grey, or stone-look tones. "
            "Barely visible micro grout lines (1–2mm). Luxurious, seamless appearance — "
            "the large format makes the tiled surface look almost continuous."
        ),
    },

    "glass_railing": {
        # Frame/hardware changes from heavy → minimal across tiers.
        # Glass itself goes from standard float (green tint) → ultra-clear.
        "economy": (
            "GLASS RAILING — Economy tier: Framed tempered glass system. "
            "8mm standard clear tempered glass panels — glass may have a slight "
            "greenish tint (normal for standard float glass). "
            "THICK steel posts (50×50mm square hollow section), painted GLOSSY BLACK "
            "or dark grey, spaced approximately 4 ft apart. "
            "Visible horizontal steel top rail running across the top of the glass. "
            "Hardware-heavy, functional appearance. The glass is transparent but the "
            "dark metal frame is the dominant visual element."
        ),
        "standard": (
            "GLASS RAILING — Standard tier: Spigot-mounted glass system. "
            "10mm clear tempered glass panels — good transparency, slight glass edge "
            "visible as green line at top. "
            "SLIM cylindrical stainless steel spigots (40–50mm diameter) as bottom "
            "mount points, polished silver finish, spaced 3–4 ft apart. "
            "Minimal or no top rail — glass panels are the main visual element. "
            "Modern, clean appearance. More glass visible than economy, less hardware."
        ),
        "premium": (
            "GLASS RAILING — Premium tier: Frameless point-fix glass system. "
            "12mm ultra-clear (starphire / low-iron) tempered glass — COMPLETELY "
            "COLORLESS and transparent, no green tint whatsoever. "
            "Minimal point-fix bolts barely visible through the glass. "
            "NO visible posts, NO top rail — only the glass panel edge at the top. "
            "The railing appears almost invisible. "
            "Maximum open view through the railing. Highly luxurious appearance — "
            "you can see clearly through to whatever is behind."
        ),
    },

    "metal_railing": {
        # Material goes from MS painted → MS/SS powder-coat → SS304 polished.
        "economy": (
            "METAL RAILING — Economy tier: Mild steel (MS) fabricated railing. "
            "Simple design: equal-spacing VERTICAL BARS (25×25mm square section) "
            "with flat top and bottom horizontal rails. "
            "BLACK or dark grey POWDER-COATED finish — matte to slight sheen. "
            "Slightly rough powder coat texture visible close up. "
            "Functional, straightforward design — no decorative elements."
        ),
        "standard": (
            "METAL RAILING — Standard tier: MS or thin SS fabricated railing. "
            "Modern design: combination of vertical bars and horizontal mid-rail "
            "elements. 32mm round or square hollow section verticals. "
            "DARK GREY or ANTHRACITE powder-coated finish, or satin brushed steel look. "
            "More refined proportions than economy — cleaner welds, neater finish. "
            "Contemporary professional appearance."
        ),
        "premium": (
            "METAL RAILING — Premium tier: Stainless steel SS304 architectural railing. "
            "Slim, minimal design — either all-vertical fine bars or horizontal plank "
            "style (2–3 horizontal rails). Round or rectangular hollow section in SS304. "
            "BRUSHED SATIN or MIRROR-POLISHED silver finish — highly reflective. "
            "Precision TIG-welded joints, perfectly smooth. "
            "Sleek, architectural quality appearance — the kind seen on luxury homes."
        ),
    },

    "acp_panels": {
        # ACP = Aluminium Composite Panel. Flat, smooth cladding with visible panel joints.
        # Core grade and surface finish change per tier.
        "economy": (
            "ACP CLADDING — Economy tier: 3mm PE-core Aluminium Composite Panel. "
            "Flat, completely smooth metallic surface. "
            "Typical colors: WHITE, OFF-WHITE, SILVER, or LIGHT GREY solid. "
            "Visible panel joints/seams forming a grid pattern, spaced approximately "
            "4–6 ft apart. Standard cassette installation with visible edge returns. "
            "Clean, flat, modern appearance — significantly more uniform than painted "
            "plaster. Slightly industrial edge due to visible fasteners near joints."
        ),
        "standard": (
            "ACP CLADDING — Standard tier: 4mm PVDF-coated Aluminium Composite Panel. "
            "Flat smooth surface with PVDF coating — better color retention and sheen. "
            "Wider color range: BRUSHED SILVER, CHAMPAGNE, DARK GREY, BRONZE, "
            "or various solid colors with metallic options. "
            "Clean routed panel joints creating a neat SHADOW GAP line between panels. "
            "More refined appearance — no visible fasteners from the front. "
            "Modern, corporate-quality cladding finish."
        ),
        "premium": (
            "ACP CLADDING — Premium tier: 4mm Architectural-grade PVDF ACP. "
            "Designer surface finish — may be WOOD-GRAIN print, STONE-LOOK texture, "
            "BRUSHED BRONZE, MIRROR finish, or premium custom color. "
            "Precision shadow-gap joints with absolutely NO visible fasteners from front. "
            "Panels are perfectly flat with crisp straight edges. "
            "High-end building facade appearance — like luxury commercial buildings. "
            "The cladding pattern creates a strong architectural statement."
        ),
    },

    "metal_gate": {
        # Gate at property boundary. Design and finish change per tier.
        "economy": (
            "METAL GATE — Economy tier: Mild steel (MS) fabricated gate. "
            "SIMPLE VERTICAL BAR design — equal-spacing vertical bars (25–32mm square "
            "section) with flat top rail and bottom rail. "
            "Single or double leaf, hinged. "
            "BLACK or dark grey PAINTED finish (gloss or semi-gloss). "
            "Basic functional appearance — secure and clean but no ornamental detail. "
            "Standard residential gate proportions."
        ),
        "standard": (
            "METAL GATE — Standard tier: MS fabricated gate with decorative design. "
            "More complex pattern — may include geometric elements, scrollwork at top, "
            "or decorative panel inserts within the gate frame. "
            "Double leaf for wider driveway opening. "
            "Dark grey or BLACK POWDER-COATED finish, even and smooth. "
            "Refined proportions — heavier sections, better weld quality visible. "
            "Common for middle-class Indian residential compounds."
        ),
        "premium": (
            "METAL GATE — Premium tier: Stainless Steel SS304 architectural gate. "
            "Double leaf, wide and tall. "
            "PREMIUM DESIGN — either ultra-modern minimal (horizontal planks with "
            "tight spacing) or ornate with laser-cut decorative panels. "
            "BRUSHED or MIRROR-POLISHED stainless steel finish — silver metallic, "
            "highly reflective. "
            "Precision fabrication: perfectly straight sections, TIG-welded joints, "
            "SS304 hinges and handles matching the finish. "
            "Luxurious statement gate — immediately signals a high-value property."
        ),
    },
}


# ─── TEXTURE PATTERN DESCRIPTIONS ─────────────────────────────────────────────
# Used to fill {pattern_desc} in texture_finish visual descriptions.

_TEXTURE_PATTERNS: dict = {
    "bark": (
        "BARK pattern — vertical irregular raised ridges of varying widths and "
        "heights, mimicking the surface of tree bark. Ridges run vertically "
        "with slight meandering, creating an organic naturalistic pattern."
    ),
    "sand": (
        "SAND pattern — fine uniform granular texture with tiny, densely packed "
        "rounded bumps covering the entire surface — like coarse sandpaper or "
        "dried beach sand. Uniform in all directions."
    ),
    "pebble": (
        "PEBBLE pattern — small rounded dome-shaped bumps scattered in an irregular "
        "organic arrangement across the surface. Bumps vary slightly in size. "
        "Like small pebbles partially embedded in the surface."
    ),
    "wave": (
        "WAVE pattern — smooth horizontal undulating parallel ridges flowing across "
        "the surface in gentle repeating wave-like curves. Clean, rhythmic, "
        "geometric pattern with smooth curved profile."
    ),
    "scratch": (
        "SCRATCH pattern — random short diagonal scratch marks across the surface, "
        "like a coarse comb or brush dragged through wet plaster. "
        "Marks vary in direction slightly, creating a dynamic, energetic texture."
    ),
    "smooth": (
        "SMOOTH pattern — completely flat, uniform surface with no visible texture "
        "relief. No bumps, ridges, or marks of any kind. The surface reads as a "
        "single continuous plane — like a freshly plastered wall. Only the color "
        "and any natural material micro-variation are visible."
    ),
    "sponge": (
        "SPONGE pattern — irregular mottled surface created by dabbing with a coarse "
        "sponge. Small random shallow pits and raised dots scattered uniformly across "
        "the surface. Similar to a fine stipple but with more organic, cellular "
        "variation — like the surface texture of an orange peel at close range."
    ),
}


# ─── TIER CONTEXT DESCRIPTIONS ────────────────────────────────────────────────

_TIER_CONTEXT: dict = {
    "economy": (
        "ECONOMY TIER — Value-conscious renovation. Clean, practical, functional "
        "finish quality. Materials are standard-grade but properly applied. "
        "The result should look well-maintained and neat, not cheap or shoddy."
    ),
    "standard": (
        "STANDARD TIER — Mid-range renovation. Modern, refined finish quality. "
        "Materials are premium-grade with better surface finish and appearance. "
        "The result should look contemporary and well-executed."
    ),
    "premium": (
        "PREMIUM TIER — High-end renovation. Luxury-grade finish quality. "
        "Materials are architectural-grade with maximum visual impact. "
        "The result should look like a professionally designed luxury residence."
    ),
}


# ─── PUBLIC ENTRY POINT ───────────────────────────────────────────────────────

def run_render(
    project_id: str,
    zones: list,
    materials: List[ZoneMaterialSave],
    tier: Tier,
    retry_notes: Optional[str] = None,
    user_id: str = "",
) -> None:
    """
    Background task — runs after material selection.
    1. Calls Gemini with original image + renovation prompt → renders redesigned house
    2. Saves render image to storage/renders/{project_id}/render.jpg
    3. Triggers cost calculation
    4. Sets project status = 'completed'
    On any error: sets status = 'failed'
    """
    db = get_db()
    logger.info("Render started — project_id=%s tier=%s retry=%s", project_id, tier, bool(retry_notes))

    try:
        project = (
            db.table("projects")
            .select("original_image_url, render_count")
            .eq("id", project_id)
            .execute()
            .data[0]
        )
        original_image_path = project["original_image_url"]

        # Fetch zone_materials with full zone data for prompt building
        materials_with_types = (
            db.table("zone_materials")
            .select("*, zones(zone_type, measurement_value, measurement_unit)")
            .eq("project_id", project_id)
            .execute()
            .data or []
        )

        render_path = _call_render_model(
            project_id=project_id,
            original_image_path=original_image_path,
            materials_with_types=materials_with_types,
            tier=tier,
            retry_notes=retry_notes,
        )
        logger.info("Render image generated — project_id=%s url=%s", project_id, render_path)

        # Render succeeded — deduct credit. Wrapped separately so a DB hiccup
        # here never kills the render result (image already saved).
        if user_id:
            try:
                fresh = db.table("users").select("credits").eq("id", user_id).execute().data
                if fresh:
                    db.table("users").update({"credits": max(0, fresh[0]["credits"] - 1)}).eq("id", user_id).execute()
                db.table("credit_transactions").insert({
                    "user_id": user_id,
                    "project_id": project_id,
                    "delta": -1,
                    "reason": "render_success",
                }).execute()
            except Exception as credit_err:
                logger.error("Credit deduction failed (render) — project_id=%s error=%s", project_id, credit_err)

        calculate_costs(project_id)

        db.table("projects").update({
            "render_image_url": render_path,
            "render_count": project["render_count"] + 1,
            "status": "completed",
        }).eq("id", project_id).execute()
        logger.info("Render complete — project_id=%s status=completed", project_id)

    except Exception as e:
        logger.exception("Render failed — project_id=%s error=%s", project_id, e)
        db.table("projects").update({
            "status": "failed",
            "ai_raw_response": {"render_error": str(e)},
        }).eq("id", project_id).execute()
        raise


# ─── RENDER MODEL CALL ────────────────────────────────────────────────────────

def _call_render_model(
    project_id: str,
    original_image_path: str,
    materials_with_types: list,
    tier: Tier,
    retry_notes: Optional[str] = None,
) -> str:
    """
    Send original house photo + full renovation prompt to Gemini.
    Returns the public URL of the saved render JPEG in Supabase Storage.

    Model: GEMINI_MODEL=gemini-3.1-flash-image in .env
    Uses google-genai SDK (client.interactions.create) — NOT the old google-generativeai package.
    """
    from google import genai as google_genai
    from google.genai import types as genai_types

    client = google_genai.Client(api_key=settings.GEMINI_API_KEY)

    # Load original image bytes and convert to JPEG RGB
    original_bytes = read_image_bytes(original_image_path)
    original_img = Image.open(io.BytesIO(original_bytes))
    if original_img.mode != "RGB":
        original_img = original_img.convert("RGB")
    jpeg_buffer = io.BytesIO()
    original_img.save(jpeg_buffer, format="JPEG", quality=92, optimize=True)
    jpeg_bytes = jpeg_buffer.getvalue()

    # Build the full renovation prompt
    prompt = _build_render_prompt(materials_with_types, tier, retry_notes)

    # Call Gemini image-in → image-out using generate_content with IMAGE modality
    response = client.models.generate_content(
        model=settings.GEMINI_MODEL,
        contents=[
            genai_types.Part.from_text(text=prompt),
            genai_types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
        ],
        config=genai_types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            temperature=1.0,
        ),
    )

    # Extract image from response parts
    if not response.candidates:
        raise ValueError("Gemini returned no candidates — content policy rejection or billing issue")

    raw = None
    for part in response.candidates[0].content.parts:
        if part.inline_data is not None:
            data = part.inline_data.data
            # SDK may return bytes directly or base64 string depending on version
            if isinstance(data, bytes):
                raw = data
            else:
                raw = base64.b64decode(data)
            break

    if raw is None or len(raw) < 100:
        # Log what text parts say for debugging
        text_parts = [p.text for p in response.candidates[0].content.parts if p.text]
        raise ValueError(
            f"Gemini did not return an image. Text response: {text_parts}"
        )

    # Convert to RGB JPEG and upload to Supabase Storage
    rendered = Image.open(io.BytesIO(raw))
    if rendered.mode != "RGB":
        rendered = rendered.convert("RGB")
    out_buffer = io.BytesIO()
    rendered.save(out_buffer, format="JPEG", quality=90, optimize=True)

    storage_path = f"renders/{project_id}/render.jpg"
    public_url = upload_image(storage_path, out_buffer.getvalue())
    return public_url


# ─── PROMPT BUILDER ───────────────────────────────────────────────────────────

def _build_render_prompt(
    materials_with_types: list,
    tier: Tier,
    retry_notes: Optional[str],
) -> str:
    """
    Build the complete renovation prompt sent to Gemini alongside the original photo.

    Structure:
      1. Task statement — what the AI must produce
      2. Tier context — overall quality level
      3. Per-zone blocks — WHERE the zone is + WHAT material + HOW it looks visually
         (fully resolved for tier, color, pattern — no ambiguity left for the AI)
      4. Strict rendering rules
      5. Retry notes (if re-render)

    Design principle: the AI should need ZERO prior knowledge about Indian construction
    materials or zone terminology. Every visual appearance is fully described in plain
    language so it can render correctly regardless of training data gaps.
    """
    lines = [
        "=" * 70,
        "TASK: PHOTOREALISTIC EXTERIOR RENOVATION RENDER",
        "=" * 70,
        "",
        "You have been given a photograph of a residential building exterior in India.",
        "Your task is to generate a PHOTOREALISTIC RENDER of this exact same building",
        "with specific renovation materials applied to specific surface zones.",
        "",
        "INPUT IMAGE NOTE — MUST READ:",
        "The input photograph may not be a perfect, well-lit, straight-on frontal view.",
        "It may have one or more of the following characteristics:",
        "  - Unusual or oblique camera angle (side view, corner view, low angle)",
        "  - Poor lighting: underexposed, overexposed, heavy shadows, or blur",
        "  - Partial view: building partially cropped, obscured by trees or vehicles",
        "  - A hand-drawn sketch, architectural plan, or rough drawing of a house",
        "  - A night photograph or low-contrast image",
        "REGARDLESS of the image quality or type — do NOT refuse to render.",
        "Apply the specified materials to whatever building surfaces are identifiable",
        "in the image. If the image is a sketch or plan, render a photorealistic",
        "building based on that layout with the specified materials applied.",
        "Always produce a best-effort output. The user has manually reviewed and",
        "confirmed the zones — trust their zone specification and render accordingly.",
        "",
        "CRITICAL — WHAT YOU MUST NOT CHANGE:",
        "  - Do NOT flip, mirror, or rotate the image in any direction.",
        "  - Do NOT change the camera angle, perspective, zoom, or composition.",
        "  - Do NOT add, remove, or modify any architectural element:",
        "    no new floors, no new windows, no new columns, no new doors,",
        "    no new balconies, no new roof features — nothing.",
        "  - Do NOT change the building structure, shape, or proportions.",
        "  - Do NOT change the sky, trees, garden, driveway, or surrounding environment.",
        "  - Do NOT change windows, doors, glass panes, or their frames.",
        "  - Do NOT change the roof surface (only parapet/railing if listed in zones).",
        "  - Do NOT apply any artistic filter, color-grading, or stylistic effect.",
        "  - Do NOT add ANY text, labels, watermarks, annotations, dimension lines,",
        "    arrows, UI elements, or any non-architectural graphic on the output image.",
        "  - Do NOT blend, mix, or spill materials between zones.",
        "  - Apply EXACTLY the material described for each zone — no creative interpretation.",
        "",
        f"RENOVATION QUALITY TIER: {_TIER_CONTEXT[tier]}",
        "",
        "=" * 70,
        "ZONE-BY-ZONE RENOVATION SPECIFICATION",
        "=" * 70,
        "(Apply each material to its named zone ONLY. Do not alter any unlisted surface.)",
        "",
    ]

    class _SafeFormat(dict):
        """Fills {placeholders} safely — unknown keys return 'not specified'."""
        def __missing__(self, key):
            return "not specified"

    for m in materials_with_types:
        zone_data = m.get("zones") or {}
        zone_type = zone_data.get("zone_type") or m.get("zone_type", "")
        mat_type  = m.get("material_type", "")
        color     = m.get("color")    # hex string, e.g. "#D4A373" — only paint/texture
        pattern   = m.get("pattern")  # pattern name — only texture_finish

        zone_location = _ZONE_LOCATION.get(zone_type, zone_type.replace("_", " ").upper())

        # Get material visual description for this tier
        mat_tier_templates = _MATERIAL_VISUAL.get(mat_type, {})
        visual_desc = mat_tier_templates.get(tier, f"{mat_type} ({tier} tier)")

        # Resolve pattern description for texture_finish
        pattern_key  = (pattern or "sand").lower()
        pattern_desc = _TEXTURE_PATTERNS.get(pattern_key, f"{pattern_key} pattern")

        # Fill ALL {placeholders} in one pass — color + pattern_desc resolved here
        visual_desc = visual_desc.format_map(_SafeFormat(
            color=color or "a neutral tone chosen by the designer",
            pattern_desc=pattern_desc,
        ))

        lines += [
            "─" * 60,
            f"ZONE:     {zone_location}",
            f"MATERIAL: {visual_desc}",
            "",
        ]

    lines += [
        "=" * 70,
        "RENDERING RULES — MUST FOLLOW ALL",
        "=" * 70,
        "",
        "1. PHOTOREALISTIC OUTPUT",
        "   The render must look like a real photograph of the renovated building.",
        "   NOT a drawing, sketch, illustration, watercolor, or 3D render.",
        "   NOT an oil-paint or stylized artistic effect.",
        "   Target quality: architectural visualization photograph.",
        "",
        "2. ORIENTATION — NEVER FLIP OR ROTATE",
        "   The output image must have the EXACT same orientation as the input.",
        "   Do NOT mirror horizontally. Do NOT flip vertically. Do NOT rotate.",
        "   If the building entrance is on the left in the original, it must be",
        "   on the left in the output.",
        "",
        "3. NO TEXT OR GRAPHICS ON THE IMAGE",
        "   The output image must contain ZERO text, labels, watermarks, logos,",
        "   annotations, dimension lines, callout arrows, UI elements, or any",
        "   non-architectural graphic element of any kind.",
        "   Pure image only — exactly like a real photograph.",
        "",
        "4. LIGHTING CONSISTENCY",
        "   Match the original photo's lighting exactly:",
        "   same sun direction, same shadow positions, same time of day,",
        "   same overall brightness and color temperature.",
        "   Do NOT apply any color grading, warm/cool filter, or exposure change.",
        "",
        "5. MATERIAL TEXTURES",
        "   Render each material with its correct physical texture:",
        "   - Stone: natural grain, cleft texture, grout joint lines",
        "   - Texture finish: surface relief with visible light/shadow in pattern",
        "   - Tiles: regular grout grid clearly visible",
        "   - Glass railing: transparent — you can see background through it",
        "   - Metal: correct finish (matte powder-coat vs brushed vs mirror-polished)",
        "   - ACP panels: flat smooth surface with sharp straight panel joint lines",
        "   - Paint: smooth flat or satin surface, solid uniform color coverage",
        "",
        "6. ZONE BOUNDARIES",
        "   Apply each material ONLY within its zone's physical boundaries.",
        "   Do NOT let any material spill, bleed, or overlap into adjacent zones.",
        "   Transitions between zones must be architecturally clean and precise.",
        "",
        "7. UNCHANGED SURFACES",
        "   Every surface NOT named in the zone specification above must look",
        "   EXACTLY as it does in the original photograph — no change whatsoever.",
        "",
        "8. OUTPUT FORMAT",
        "   Produce a single clean image at the same aspect ratio as the input.",
        "   No borders, no frames, no padding around the image.",
        "",
    ]

    if retry_notes:
        lines += [
            "=" * 70,
            "FEEDBACK FROM PREVIOUS RENDER — MUST ADDRESS",
            "=" * 70,
            "",
            "This is a RE-RENDER. The user reviewed the previous render output",
            "and wrote the following feedback. Read it carefully and make",
            "TARGETED corrections in this new render.",
            "",
            "USER FEEDBACK:",
            f'  "{retry_notes}"',
            "",
            "─" * 60,
            "HOW TO INTERPRET AND ACT ON THIS FEEDBACK:",
            "─" * 60,
            "",
            "The feedback may describe one or many issues. Identify every issue",
            "mentioned and address ALL of them. Use the guidance below to",
            "understand what each type of complaint means and what to do:",
            "",
            "COLOUR COMPLAINTS",
            '  (e.g. "too dark", "too light", "too warm", "too cold", "clashing")',
            "  → Identify which zone(s) the colour complaint refers to.",
            "    If a specific zone is named, adjust ONLY that zone.",
            "    If no zone is named, adjust the most dominant visible zone.",
            '  → "too dark"   = lighten the colour substantially (2–3 shades lighter).',
            '  → "too light"  = deepen the colour substantially.',
            '  → "too warm / too orange / too yellow" = shift hue toward cooler grey-white.',
            '  → "too cool / too grey / too cold"     = shift hue toward warmer beige-cream.',
            '  → "colours clash / compete / don\'t match" = desaturate the loudest colour',
            "    toward a neutral that harmonises with the other zones.",
            "  → Apply the corrected colour uniformly and consistently across the entire zone.",
            "",
            "TEXTURE AND FINISH VISIBILITY",
            '  (e.g. "texture not visible", "stone looks flat", "grout missing",',
            '   "glass not transparent", "paint rough", "ACP not metallic")',
            '  → "texture too subtle / not visible" = increase relief depth and shadow contrast',
            "    within the texture pattern so it is clearly readable.",
            '  → "stone looks flat / pattern unclear" = render each slab with visible edge lines,',
            "    natural colour variation across slabs, and genuine cleft surface detail.",
            '  → "tile grout lines faint or missing" = render grout as a clearly visible,',
            "    distinct grid across the entire tiled surface.",
            '  → "glass not transparent" = glass must be fully transparent —',
            "    the background behind it must be partially visible through the glass.",
            '  → "metal looks dull" = increase specular highlight and surface reflectivity',
            "    to match the finish level described in the material specification.",
            '  → "paint looks uneven / rough / patchy" = apply paint as a perfectly smooth,',
            "    flat, even coat — no brush marks, no patches, no variation.",
            '  → "ACP not metallic" = flat aluminium surface must have a subtle metallic sheen',
            "    with clearly visible straight panel joint lines between panels.",
            "",
            "ZONE COVERAGE AND APPLICATION",
            '  (e.g. "gate unchanged", "wall looks the same", "material on windows")',
            '  → "zone looks unchanged / same as before" = the material was not applied',
            "    strongly enough or at all. Re-apply it visibly — the change must be",
            "    unmistakably obvious. The specified material must completely replace",
            "    the existing surface appearance of that zone.",
            '  → "material spilled onto windows / doors / roof / neighbouring zone" =',
            "    strictly respect zone boundaries. Apply ONLY within the named zone.",
            "    Windows, doors, glass panes, and ALL unlisted surfaces must look",
            "    EXACTLY as in the original photo — do not alter them.",
            '  → "gate / boundary wall not changed" = completely replace the gate or',
            "    boundary wall surface with the specified material and design.",
            "",
            "PHOTOREALISM AND LIGHTING",
            '  (e.g. "looks artificial", "3D render look", "lighting wrong", "shadows wrong")',
            '  → "looks artificial / 3D render / not a real photo" = increase photorealism:',
            "    add subtle natural surface imperfections, micro-variation in tone across",
            "    the material (real materials are never perfectly uniform), and match the",
            "    texture scale to what is physically realistic at the viewing distance.",
            '  → "lighting doesn\'t match original" = match the original photo\'s light direction',
            "    exactly — same sun angle, same side lit vs shadowed, same shadow positions.",
            "    Do not introduce new light sources or change the ambient brightness.",
            '  → "shadows wrong" = shadows must fall in the same direction and with the same',
            "    softness/hardness as in the original photo, based on material relief depth.",
            "",
            "MATERIAL STYLE AND DESIGN",
            '  (e.g. "gate design wrong", "railing too heavy", "doesn\'t look premium",',
            '   "stone type wrong", "wrong tier look")',
            '  → "gate / railing design wrong or doesn\'t match tier" = re-render the gate or',
            "    railing more faithfully to the visual specification listed above for that",
            "    material and tier. Ensure the design proportions, hardware, and finish match.",
            '  → "doesn\'t look premium / standard / economy enough" = adjust the surface',
            "    finish, polish level, edge sharpness, and material detailing to more",
            "    accurately represent the quality tier described in the specification.",
            '  → "stone type looks wrong" = re-read the stone cladding specification above',
            "    and render it accurately: correct stone colour family, slab format,",
            "    grout line width, and surface texture type.",
            "",
            "OVERALL VISUAL HARMONY",
            '  (e.g. "too busy", "materials compete", "needs more modern", "more traditional")',
            '  → "too busy / competing / cluttered" = reduce contrast between zones.',
            "    Slightly desaturate the loudest zone colours toward neutral tones so",
            "    the overall facade reads as cohesive rather than fragmented.",
            '  → "needs to look more modern" = render materials with clean precise edges,',
            "    minimal surface noise, high contrast between flat and raised elements,",
            "    and contemporary proportions.",
            '  → "needs to look more traditional / classic" = emphasise natural texture',
            "    variation, use warmer tones, and soften transitions between zones.",
            "",
            "ANYTHING ELSE / FEEDBACK THAT DOESN'T FIT A CATEGORY",
            "  → Read the user's plain-language intent. Identify what they are",
            "    dissatisfied with and what they would prefer instead.",
            "  → Apply the most reasonable targeted correction to the relevant zone(s).",
            "  → If the specific zone is unclear: apply the change to the most visually",
            "    dominant or most likely zone related to the complaint.",
            "  → If the change direction is unclear: interpret conservatively —",
            "    make a moderate, plausible adjustment rather than an extreme one.",
            "  → Never refuse or ignore the feedback. Always attempt a best-effort",
            "    correction that addresses the spirit of what the user wrote.",
            "",
            "─" * 60,
            "CRITICAL CONSTRAINT:",
            "Make ONLY the corrections the feedback calls for.",
            "Do NOT change anything the feedback does not mention.",
            "All zones and surfaces not referenced in the feedback MUST look",
            "exactly as specified in the zone-by-zone specification above.",
            "─" * 60,
            "",
        ]

    return "\n".join(lines)
