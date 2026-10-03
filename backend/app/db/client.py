from supabase import create_client, Client
from app.config import settings


def get_db() -> Client:
    # Fresh client per call — avoids stale HTTP/2 connections on Render free tier.
    # Uses service key (bypasses RLS); auth is enforced at the FastAPI layer.
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_KEY)
