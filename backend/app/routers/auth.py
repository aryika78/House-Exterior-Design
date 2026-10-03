"""
Auth router — /auth/google, /auth/me

POST /auth/google  — exchange Google id_token for our JWT
GET  /auth/me      — return current user profile
"""
import logging
from fastapi import APIRouter, HTTPException, Depends
from app.models.schemas import GoogleAuthRequest, AuthResponse, UserOut
from app.services.auth_service import verify_google_token, upsert_user, create_jwt
from app.dependencies.auth import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


@router.post("/google", response_model=AuthResponse)
def google_login(body: GoogleAuthRequest):
    """
    Verify Google id_token, upsert user, return our JWT.
    Frontend calls this immediately after Google OAuth completes.
    """
    try:
        claims = verify_google_token(body.id_token)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))

    user = upsert_user(claims)
    token = create_jwt(user)
    logger.info("User signed in — email=%s", user.get("email"))

    return AuthResponse(
        access_token=token,
        user=UserOut(
            id=user["id"],
            email=user["email"],
            name=user["name"],
            credits=user["credits"],
        ),
    )


@router.get("/me", response_model=UserOut)
def get_me(current_user: dict = Depends(get_current_user)):
    """Return the currently authenticated user. Frontend uses this on app load."""
    return UserOut(
        id=current_user["id"],
        email=current_user["email"],
        name=current_user["name"],
        credits=current_user["credits"],
    )
