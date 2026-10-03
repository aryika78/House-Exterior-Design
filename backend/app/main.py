import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.config import settings
from app.routers import auth, projects

# ─── Logging setup ────────────────────────────────────────────────────────────
# Configure once at app startup.  All loggers in the app inherit this config.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("e2m")

app = FastAPI(
    title="E2M Exterior Renovation API",
    version="1.0.0",
    debug=settings.DEBUG,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Global exception handler ─────────────────────────────────────────────────
# Catches any unhandled exception that would otherwise bubble up as a raw 500.
# Returns a friendly JSON response with a short error ID for support/debugging.
# The full traceback is logged server-side so it can be found in Railway/Render logs.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    error_id = str(uuid.uuid4())[:8].upper()
    logger.exception(
        "Unhandled error [%s] — %s %s",
        error_id,
        request.method,
        request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": (
                f"Something went wrong on our end (Error ID: {error_id}). "
                "Please try again. If the problem persists, contact support."
            )
        },
    )


# Images are served from Supabase Storage — no local static file mounts needed.

# Routers
app.include_router(auth.router)
app.include_router(projects.router)


@app.on_event("startup")
def on_startup() -> None:
    logger.info("E2M API starting up — version 1.0.0")
    recover_stuck_projects()


def recover_stuck_projects() -> None:
    """
    On every boot, find projects still in transient AI-processing states and
    mark them failed. These are projects whose background task was killed mid-flight
    by a server restart/redeploy.

    User sees a 'Failed' card in their dashboard and can retry from there.
    Better than an infinite spinner with no escape.
    """
    try:
        from app.db.client import get_db
        db = get_db()
        result = db.table("projects").update({
            "status": "failed",
            "ai_raw_response": {
                "error": "Server restarted while processing. Please retry from your dashboard."
            },
        }).in_("status", ["detecting", "rendering"]).execute()
        recovered = len(result.data) if result.data else 0
        if recovered:
            logger.warning("Startup recovery: marked %d stuck project(s) as failed", recovered)
        else:
            logger.info("Startup recovery: no stuck projects found")
    except Exception:
        logger.warning("Startup recovery skipped — DB may not be ready yet")
        pass  # Never crash startup — DB might be unreachable briefly on cold start


@app.get("/health")
def health():
    return {"status": "ok"}
