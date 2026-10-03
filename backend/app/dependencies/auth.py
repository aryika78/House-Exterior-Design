"""
FastAPI dependency: get_current_user

Usage in any route:
    from app.dependencies.auth import get_current_user
    from app.models.schemas import UserOut

    @router.get("/something")
    def my_endpoint(current_user: dict = Depends(get_current_user)):
        user_id = current_user["id"]

Dev mode (REQUIRE_AUTH=False): returns dev user without checking token.
This lets us test every endpoint without Google OAuth during development.
"""
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.config import settings
from app.services.auth_service import decode_jwt, get_user_by_id, get_or_create_dev_user

_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """
    Returns the authenticated user as a DB dict.
    Raises 401 if token is missing/invalid (in auth-required mode).
    """
    if not settings.REQUIRE_AUTH:
        # Dev bypass — stable dev user, no token needed
        return get_or_create_dev_user()

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_jwt(credentials.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = get_user_by_id(payload["sub"])
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user
