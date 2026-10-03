from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_KEY: str

    # AI Models
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-sonnet-5-5"
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.1-flash-image"         # render: image-in → image-out
    GEMINI_VISION_MODEL: str = "gemini-2.5-flash"        # detection: image-in → text/JSON-out

    # Google OAuth
    GOOGLE_CLIENT_ID: str

    # Storage — Supabase Storage bucket (must exist with public access enabled)
    SUPABASE_STORAGE_BUCKET: str = "e2m-images"

    # App
    DEBUG: bool = True
    ALLOWED_ORIGINS: List[str] = ["http://localhost:5173"]

    # Auth
    JWT_SECRET: str = "dev-secret"
    REQUIRE_AUTH: bool = False

    class Config:
        env_file = ".env"


settings = Settings()
