# House Exterior Design Tool

An AI-powered web application that helps homeowners visualise and estimate the cost of exterior renovation — from a single photo.

---

## What It Does

Upload a photo of your house exterior. The AI detects the renovation zones (walls, railings, balconies, gates, etc.), estimates their areas, and lets you pick materials and a quality tier. It then generates a photorealistic render of how your home could look, and produces a full itemised cost breakdown with wastage-adjusted calculations.

**Full flow:**
1. Upload a house exterior photo
2. AI detects zones and estimates areas — you review and edit
3. Pick a quality tier (Economy / Standard / Premium) and assign materials per zone
4. AI generates a photorealistic renovation preview
5. View cost breakdown, edit measurements inline, download PDF report

---

## Features

- **AI Zone Detection** — Gemini 2.5 Flash identifies walls, columns, balconies, railings, gates, and boundary walls from the photo
- **HITL Review** — user confirms, edits, or adds zones before proceeding
- **Material Catalog** — 8 material types with tier-based pricing, colour swatches, and texture options
- **Photorealistic Render** — Gemini image model generates a renovation preview based on zone layout and material choices
- **Cost Estimation** — CPWD-based wastage factors, inline-editable breakdown, live recalculation
- **PDF Report** — 3-section report (original photo, render, materials + cost tables)
- **Retry Flow** — re-render with feedback notes, or go back to zone review and start fresh
- **Project History** — all projects saved, resumable at any step

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript (Vite) |
| Backend | Python FastAPI |
| Database | Supabase (PostgreSQL) |
| File Storage | Supabase Storage |
| Auth | Google OAuth 2.0 + JWT |
| AI — Detection | Gemini 2.5 Flash |
| AI — Rendering | Gemini Flash Image |
| Deployment | Render |

---

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.11+
- Supabase project
- Google OAuth client ID
- Gemini API key

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env      # Fill in your credentials
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env      # Set VITE_API_BASE_URL and VITE_GOOGLE_CLIENT_ID
npm run dev
```

### Database

Run `backend/supabase_schema.sql` in your Supabase SQL editor to create all tables and enums.

---

## Environment Variables

**Backend** (`.env`):
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_STORAGE_BUCKET=
GEMINI_API_KEY=
GEMINI_VISION_MODEL=gemini-2.5-flash
GOOGLE_CLIENT_ID=
JWT_SECRET=
REQUIRE_AUTH=True
```

**Frontend** (`.env`):
```
VITE_API_BASE_URL=http://localhost:8000
VITE_GOOGLE_CLIENT_ID=
```

---

## License

MIT
