"""
Storage service — Supabase Storage for persistent image hosting.

Replaces local filesystem. Images survive server restarts/redeploys on
Railway/Render which have ephemeral (non-persistent) filesystems.

Bucket layout (bucket name set in SUPABASE_STORAGE_BUCKET env var):
  uploads/{project_id}/original.jpg  — user-uploaded house photo
  renders/{project_id}/render.jpg    — AI-generated renovation render

The bucket must be created in Supabase dashboard with public access ON.
Both paths are upserted (overwrite on re-render or re-upload).
"""
import logging
import time
import urllib.request

from app.config import settings
from app.db.client import get_db

logger = logging.getLogger(__name__)


def upload_image(storage_path: str, image_bytes: bytes) -> str:
    """
    Upload JPEG bytes to Supabase Storage.
    Returns the public URL with a timestamp cache-buster query param.

    The cache-buster (?t=<unix_ts>) ensures browsers never serve a stale
    cached version after a re-render overwrites the same storage path.

    storage_path: relative path inside bucket, e.g. "uploads/{id}/original.jpg"
    """
    db = get_db()
    logger.info("Storage upload started — path=%s size=%db", storage_path, len(image_bytes))
    db.storage.from_(settings.SUPABASE_STORAGE_BUCKET).upload(
        path=storage_path,
        file=image_bytes,
        file_options={"content-type": "image/jpeg", "upsert": "true"},
    )
    base_url = db.storage.from_(settings.SUPABASE_STORAGE_BUCKET).get_public_url(storage_path)
    # Append timestamp so every upload gets a unique URL — prevents CDN/browser
    # from serving the old cached render image after a re-render.
    public_url = f"{base_url}?t={int(time.time())}"
    logger.info("Storage upload complete — path=%s", storage_path)
    return public_url


def read_image_bytes(path_or_url: str) -> bytes:
    """
    Read image bytes from a Supabase public URL or a local file path.
    Local path support keeps local dev working without code changes.
    """
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        with urllib.request.urlopen(path_or_url) as resp:
            return resp.read()
    with open(path_or_url, "rb") as f:
        return f.read()
