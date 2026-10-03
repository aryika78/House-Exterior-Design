"""
Image processing service — Pillow compression pipeline.

Rules:
- EXIF orientation applied first (portrait phone photos must be rotated before saving)
- Max dimension: 2048px (longest side, proportional resize)
- Format: JPEG
- Quality: 85
- EXIF metadata stripped (privacy + size reduction) — NOT copied to output

Returns processed JPEG bytes. Caller is responsible for storage (Supabase Storage).
"""
import io
from PIL import Image, ImageOps


def process_upload(raw_bytes: bytes) -> bytes:
    """
    Compress uploaded image and return processed JPEG bytes.
    Input: raw bytes from upload.
    Output: JPEG bytes — orientation-corrected, resized, EXIF stripped.
    """
    img = Image.open(io.BytesIO(raw_bytes))

    # Apply EXIF orientation BEFORE any other transform.
    # Phones tag portrait photos with a rotation flag instead of rotating pixel
    # data. If we strip EXIF without rotating first, the saved JPEG appears
    # sideways. exif_transpose reads the tag, rotates pixel data, then discards
    # the tag — so the output is always upright with no EXIF.
    img = ImageOps.exif_transpose(img)

    # Convert RGBA / P (palette) / L (grayscale) / etc → RGB
    # JPEG format does not support transparency or palette modes.
    if img.mode != "RGB":
        img = img.convert("RGB")

    # Resize: max 2048px on longest side, preserve aspect ratio
    max_dim = 2048
    w, h = img.size
    if w > max_dim or h > max_dim:
        ratio = min(max_dim / w, max_dim / h)
        new_size = (int(w * ratio), int(h * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    # Encode to JPEG bytes without EXIF (do NOT copy image.info — that carries EXIF)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85, optimize=True)
    return out.getvalue()
