from supabase import create_client, Client
from app.config import settings

# Singleton — one client for the process lifetime.
# Uses service key (bypasses RLS) — safe because all auth is handled at the FastAPI layer.
_client: Client | None = None


def get_db() -> Client:
    global _client
    if _client is None:
        _client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_KEY)
    return _client
