"""
Auth Service — Google ID token verification, JWT issuance, user upsert.

Flow:
  1. Frontend receives Google id_token after OAuth consent
  2. POST /auth/google → verify_google_token() → upsert_user() → create_jwt()
  3. All subsequent requests carry our JWT in Authorization: Bearer <token>
"""
import jwt
import time
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from app.config import settings
from app.db.client import get_db
from app.models.schemas import UserOut

_google_request = google_requests.Request()

# JWT expiry: 7 days
JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60
JWT_ALGORITHM = "HS256"


def verify_google_token(token: str) -> dict:
    """
    Verify Google id_token with Google's public keys.
    Returns claims dict: {sub, email, name, picture, ...}
    Raises ValueError on invalid/expired token.
    """
    try:
        claims = id_token.verify_oauth2_token(
            token,
            _google_request,
            settings.GOOGLE_CLIENT_ID,
        )
        return claims
    except Exception as e:
        raise ValueError(f"Invalid Google token: {e}")


def upsert_user(google_claims: dict) -> dict:
    """
    Create user if not exists, or return existing user.
    Matches on google_id first, then email as fallback.
    Returns the DB row as a dict.
    """
    db = get_db()
    google_id = google_claims["sub"]
    email = google_claims["email"]
    name = google_claims.get("name", email.split("@")[0])

    # Try by google_id first
    result = db.table("users").select("*").eq("google_id", google_id).execute()
    if result.data:
        return result.data[0]

    # Try by email (user may have logged in a different way before)
    result = db.table("users").select("*").eq("email", email).execute()
    if result.data:
        # Link google_id to existing account
        user_id = result.data[0]["id"]
        db.table("users").update({"google_id": google_id}).eq("id", user_id).execute()
        return result.data[0]

    # New user — create with 2 credits (2 renders max)
    new_user = {
        "email": email,
        "name": name,
        "google_id": google_id,
        "credits": 2,
    }
    result = db.table("users").insert(new_user).execute()
    return result.data[0]


def create_jwt(user: dict) -> str:
    """Issue our own JWT with user_id as subject."""
    now = int(time.time())
    payload = {
        "sub": user["id"],
        "email": user["email"],
        "iat": now,
        "exp": now + JWT_EXPIRY_SECONDS,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict:
    """
    Decode and verify our JWT.
    Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError on failure.
    """
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[JWT_ALGORITHM])


def get_user_by_id(user_id: str) -> dict | None:
    """Fetch user row by primary key."""
    db = get_db()
    result = db.table("users").select("*").eq("id", user_id).execute()
    return result.data[0] if result.data else None


def get_or_create_dev_user() -> dict:
    """
    Dev mode only (REQUIRE_AUTH=False).
    Ensures the dev user exists in DB — looks up by email, creates on first call.
    Uses email as stable identifier (id is auto-generated UUID by DB).
    """
    db = get_db()
    dev_email = "dev@e2m.local"

    result = db.table("users").select("*").eq("email", dev_email).execute()
    if result.data:
        return result.data[0]

    new_user = {
        "email": dev_email,
        "name": "Dev User",
        "google_id": None,
        "credits": 2,
    }
    result = db.table("users").insert(new_user).execute()
    return result.data[0]
