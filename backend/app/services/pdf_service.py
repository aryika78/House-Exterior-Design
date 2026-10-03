"""
PDF Report Generation — 3-section report using ReportLab.

Sections:
  1. Cover  — app name, project info, original photo
  2. Render — AI-generated render image + disclaimer
  3. Data   — Materials summary table + Cost breakdown table (flowing, no forced break)

Design:
  - Warm colour palette matching the app: dark brown (#2C2018) + orange (#C8711A)
  - Standard Helvetica fonts (full Unicode font not required — INR used instead of Rs symbol)
  - Tables use Paragraph cells for word-wrap — no text overflow
  - Content flows naturally; no excess blank pages

Streamed directly — not stored on disk.
"""
import io
import logging
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    HRFlowable, Image as RLImage, PageBreak, Paragraph,
    SimpleDocTemplate, Spacer, Table, TableStyle,
)

from app.models.schemas import ProjectOut
from app.services.storage_service import read_image_bytes

logger = logging.getLogger(__name__)

PAGE_W, PAGE_H = A4
MARGIN = 2.0 * cm
CONTENT_W = PAGE_W - 2 * MARGIN

# ─── Colours ─────────────────────────────────────────────────────────────────
C_DARK    = colors.HexColor("#2C2018")   # app primary (dark warm brown)
C_ACCENT  = colors.HexColor("#C8711A")   # app accent (warm orange)
C_CREAM   = colors.HexColor("#F8F5F0")   # app background
C_ROW_ALT = colors.HexColor("#F5F0E8")   # alternating row tint
C_BORDER  = colors.HexColor("#E8E1D8")   # subtle border
C_MUTED   = colors.HexColor("#8A8178")   # secondary text
C_WHITE   = colors.white


# ─── Style helpers ────────────────────────────────────────────────────────────

def _h1() -> ParagraphStyle:
    return ParagraphStyle("H1", fontSize=26, textColor=C_DARK,
                          fontName="Helvetica-Bold", alignment=TA_CENTER,
                          spaceAfter=4, leading=32)

def _h2() -> ParagraphStyle:
    return ParagraphStyle("H2", fontSize=13, textColor=C_ACCENT,
                          fontName="Helvetica-Bold", alignment=TA_CENTER,
                          spaceAfter=2, leading=16)

def _h3() -> ParagraphStyle:
    return ParagraphStyle("H3", fontSize=14, textColor=C_DARK,
                          fontName="Helvetica-Bold", spaceAfter=8, leading=18)

def _meta() -> ParagraphStyle:
    return ParagraphStyle("Meta", fontSize=9, textColor=C_MUTED,
                          alignment=TA_CENTER, spaceAfter=2, leading=13)

def _body() -> ParagraphStyle:
    return ParagraphStyle("Body", fontSize=9, textColor=C_MUTED,
                          spaceAfter=4, leading=13)

def _note() -> ParagraphStyle:
    return ParagraphStyle("Note", fontSize=8, textColor=C_MUTED,
                          spaceBefore=8, leading=12)

def _total() -> ParagraphStyle:
    return ParagraphStyle("Total", fontSize=13, textColor=C_DARK,
                          fontName="Helvetica-Bold", spaceBefore=10, leading=18)

def _cell(text: str, bold: bool = False, align: str = "LEFT") -> Paragraph:
    """Wrap table cell text in a Paragraph so ReportLab can word-wrap it."""
    ta = TA_LEFT if align == "LEFT" else TA_RIGHT if align == "RIGHT" else TA_CENTER
    fn = "Helvetica-Bold" if bold else "Helvetica"
    s = ParagraphStyle("C", fontSize=8, fontName=fn, leading=11,
                       textColor=C_DARK, alignment=ta)
    return Paragraph(text, s)

def _cell_muted(text: str) -> Paragraph:
    s = ParagraphStyle("CM", fontSize=8, fontName="Helvetica", leading=11,
                       textColor=C_MUTED)
    return Paragraph(text, s)

def _hdr_cell(text: str) -> Paragraph:
    s = ParagraphStyle("CH", fontSize=8, fontName="Helvetica-Bold", leading=11,
                       textColor=C_WHITE, alignment=TA_CENTER)
    return Paragraph(text, s)


_TABLE_HEADER_STYLE = [
    ("BACKGROUND",   (0, 0), (-1, 0),  C_DARK),
    ("TEXTCOLOR",    (0, 0), (-1, 0),  C_WHITE),
    ("FONTNAME",     (0, 0), (-1, 0),  "Helvetica-Bold"),
    ("FONTSIZE",     (0, 0), (-1, 0),  8),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [C_WHITE, C_ROW_ALT]),
    ("FONTSIZE",     (0, 1), (-1, -1), 8),
    ("GRID",         (0, 0), (-1, -1), 0.4, C_BORDER),
    ("VALIGN",       (0, 0), (-1, -1), "TOP"),
    ("TOPPADDING",   (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
    ("LEFTPADDING",  (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
]


def _fmt_inr(value: float) -> str:
    """Format as INR with commas — avoids ₹ which Helvetica cannot render."""
    return f"INR {value:,.0f}"


# Human-readable unit labels
_UNIT_LABEL = {
    "sqft":      "sq ft",
    "linear_ft": "lin ft",
    "count":     "units",
}


def generate_pdf(project: ProjectOut) -> bytes:
    """Build the PDF report and return as bytes."""
    logger.info("Generating PDF — project_id=%s", project.id)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        title="RenovAI Renovation Report",
        author="RenovAI",
    )

    story: list = []

    story += _section_cover(project)
    story.append(PageBreak())
    story += _section_render(project)
    story.append(PageBreak())
    story += _section_data(project)

    doc.build(story)
    return buf.getvalue()


# ─── SECTION 1: COVER ─────────────────────────────────────────────────────────

def _section_cover(project: ProjectOut) -> list:
    tier = (project.tier or "N/A").capitalize()
    date_str = datetime.now().strftime("%d %B %Y")

    elems: list = [
        Spacer(1, 0.8 * cm),
        Paragraph("RenovAI", _h1()),
        Paragraph("Exterior Renovation Cost Report", _h2()),
        Spacer(1, 0.4 * cm),
        HRFlowable(width=CONTENT_W, thickness=1.2, color=C_ACCENT, spaceAfter=10),
        Paragraph(f"Project: {project.id[:8].upper()}", _meta()),
        Paragraph(f"Date: {date_str}", _meta()),
        Paragraph(f"Tier: {tier}", _meta()),
        Spacer(1, 0.8 * cm),
    ]

    if project.original_image_url:
        try:
            img_bytes = read_image_bytes(project.original_image_url)
            img = RLImage(io.BytesIO(img_bytes), width=CONTENT_W, height=CONTENT_W * 0.65)
            img.hAlign = "CENTER"
            elems.append(img)
        except Exception:
            elems.append(Paragraph("Original photo not available.", _body()))

    elems += [
        Spacer(1, 0.6 * cm),
        HRFlowable(width=CONTENT_W, thickness=0.5, color=C_BORDER, spaceAfter=6),
        Paragraph(
            "This report was generated by RenovAI — AI-powered exterior renovation estimator.",
            _meta(),
        ),
    ]
    return elems


# ─── SECTION 2: RENDER ────────────────────────────────────────────────────────

def _section_render(project: ProjectOut) -> list:
    elems: list = [
        Paragraph("AI-Redesigned Exterior", _h3()),
        HRFlowable(width=CONTENT_W, thickness=0.8, color=C_ACCENT, spaceAfter=10),
    ]

    if project.render_image_url:
        try:
            img_bytes = read_image_bytes(project.render_image_url)
            img = RLImage(io.BytesIO(img_bytes), width=CONTENT_W, height=CONTENT_W * 0.7)
            img.hAlign = "CENTER"
            elems.append(img)
        except Exception:
            elems.append(Paragraph("Rendered image not available.", _body()))
    else:
        elems.append(Paragraph("Rendered image not available.", _body()))

    elems += [
        Spacer(1, 0.5 * cm),
        Paragraph(
            "The rendered image is an AI-generated approximation. "
            "Actual results may vary based on site conditions, material availability, "
            "and contractor execution.",
            _body(),
        ),
    ]
    return elems


# ─── SECTION 3: MATERIALS + COST (flowing, no page break between them) ────────

def _section_data(project: ProjectOut) -> list:
    elems: list = []
    elems += _materials_table(project)
    elems.append(Spacer(1, 0.7 * cm))
    elems += _cost_table(project)
    return elems


def _materials_table(project: ProjectOut) -> list:
    elems: list = [
        Paragraph("Materials Summary", _h3()),
        HRFlowable(width=CONTENT_W, thickness=0.8, color=C_ACCENT, spaceAfter=8),
    ]

    if not project.zone_materials:
        elems.append(Paragraph("No materials recorded.", _body()))
        return elems

    zone_map = {z.id: z for z in project.zones}

    header = [
        _hdr_cell("Zone"),
        _hdr_cell("Material"),
        _hdr_cell("Area / Length"),
        _hdr_cell("Colour / Pattern"),
    ]
    rows = [header]

    for m in project.zone_materials:
        zone = zone_map.get(m.zone_id)
        area = (
            f"{zone.measurement_value:g} {_UNIT_LABEL.get(zone.measurement_unit, zone.measurement_unit.replace('_', ' '))}"
            if zone else "—"
        )
        color_pat = ", ".join(filter(None, [m.color, m.pattern])) or "—"
        rows.append([
            _cell(m.zone_type.replace("_", " ").title()),
            _cell(m.material_type.replace("_", " ").title()),
            _cell_muted(area),
            _cell_muted(color_pat),
        ])

    col_w = [CONTENT_W * p for p in (0.27, 0.27, 0.22, 0.24)]
    t = Table(rows, colWidths=col_w, repeatRows=1)
    t.setStyle(TableStyle(_TABLE_HEADER_STYLE))
    elems.append(t)
    return elems


def _cost_table(project: ProjectOut) -> list:
    elems: list = [
        Paragraph("Cost Breakdown", _h3()),
        HRFlowable(width=CONTENT_W, thickness=0.8, color=C_ACCENT, spaceAfter=8),
    ]

    if not project.cost_line_items:
        elems.append(Paragraph("No cost data available.", _body()))
        return elems

    header = [
        _hdr_cell("Zone"),
        _hdr_cell("Material"),
        _hdr_cell("Qty / Area"),
        _hdr_cell("Rate / Unit"),
        _hdr_cell("Mat. Cost"),
        _hdr_cell("Labour Cost"),
        _hdr_cell("Total"),
    ]
    rows = [header]

    for item in project.cost_line_items:
        unit_label = _UNIT_LABEL.get(item.measurement_unit, item.measurement_unit.replace("_", " "))
        # Format measurement cleanly — drop trailing .0 for whole numbers
        qty_main = f"{item.measurement:g} {unit_label}"
        # Append liters or tiles hint when available
        if item.liters_needed:
            qty_txt = f"{qty_main}<br/><font size='7'>(~{item.liters_needed:.1f} L paint)</font>"
        elif item.num_tiles:
            qty_txt = f"{qty_main}<br/><font size='7'>(~{item.num_tiles} tiles)</font>"
        else:
            qty_txt = qty_main

        rate_txt = f"{_fmt_inr(item.material_rate)} / {unit_label}"

        rows.append([
            _cell(item.zone_type.replace("_", " ").title()),
            _cell(item.material_type.replace("_", " ").title()),
            _cell_muted(qty_txt),
            _cell(rate_txt, align="RIGHT"),
            _cell(_fmt_inr(item.material_cost), align="RIGHT"),
            _cell(_fmt_inr(item.labor_cost), align="RIGHT"),
            _cell(_fmt_inr(item.zone_total), bold=True, align="RIGHT"),
        ])

    # Grand total footer row
    grand = project.total_cost or 0
    rows.append([
        _cell("Grand Total", bold=True),
        _cell(""), _cell(""), _cell(""), _cell(""),
        _cell(""),
        _cell(_fmt_inr(grand), bold=True, align="RIGHT"),
    ])

    col_w = [CONTENT_W * p for p in (0.18, 0.17, 0.15, 0.16, 0.13, 0.11, 0.10)]
    t = Table(rows, colWidths=col_w, repeatRows=1)

    footer_idx = len(rows) - 1
    style = list(_TABLE_HEADER_STYLE) + [
        ("ALIGN",       (3, 1), (-1, -1), "RIGHT"),
        ("BACKGROUND",  (0, footer_idx), (-1, footer_idx), C_ROW_ALT),
        ("FONTNAME",    (0, footer_idx), (-1, footer_idx), "Helvetica-Bold"),
        ("LINEABOVE",   (0, footer_idx), (-1, footer_idx), 1.2, C_DARK),
    ]
    t.setStyle(TableStyle(style))
    elems.append(t)

    elems.append(Spacer(1, 0.5 * cm))
    elems.append(Paragraph(
        "Note: Costs are approximate estimates based on standard Indian market rates. "
        "Includes 5-15% material wastage (CPWD standard). "
        "Actual costs may vary by region, supplier, and site conditions. "
        "This report is for planning purposes only and is not a legally binding quotation.",
        _note(),
    ))
    return elems
