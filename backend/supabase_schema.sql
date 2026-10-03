-- E2M Exterior Renovation — Supabase Schema
-- Run this in Supabase SQL Editor to create all tables

-- ─── EXTENSIONS ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── ENUMS ────────────────────────────────────────────────────────────────────
CREATE TYPE project_status AS ENUM (
  'pending',
  'detecting',
  'hitl',
  'material_selection',
  'rendering',
  'completed',
  'failed'
);

CREATE TYPE zone_type AS ENUM (
  'main_walls',
  'columns_pillars',
  'parapet_wall',
  'balcony_floor',
  'balcony_railing',
  'gate_grille',
  'gate_boundary_wall',
  'roof_edge_railing'
);

CREATE TYPE material_type AS ENUM (
  'paint',
  'stone_cladding',
  'texture_finish',
  'tiles',
  'glass_railing',
  'metal_railing',
  'acp_panels',
  'metal_gate'
);

CREATE TYPE measurement_unit AS ENUM (
  'sqft',
  'linear_ft',
  'count'
);

CREATE TYPE tier AS ENUM (
  'economy',
  'standard',
  'premium'
);

-- ─── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  google_id   TEXT UNIQUE,
  credits     INTEGER NOT NULL DEFAULT 3,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PROJECTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              project_status NOT NULL DEFAULT 'pending',
  tier                tier,
  original_image_url  TEXT,
  render_image_url    TEXT,
  render_count        INTEGER NOT NULL DEFAULT 0,
  total_cost          NUMERIC(12, 2),
  ai_raw_response     JSONB,       -- raw AI zone detection output for audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ZONES ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  zone_type           zone_type NOT NULL,
  measurement_value   NUMERIC(10, 2) NOT NULL,
  measurement_unit    measurement_unit NOT NULL,
  ai_detected         BOOLEAN NOT NULL DEFAULT TRUE,   -- false if user manually added
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, zone_type)   -- one row per zone type per project; prevents duplicate cost entries
);

-- ─── ZONE MATERIALS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zone_materials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  zone_id       UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  material_type material_type NOT NULL,
  color         TEXT,      -- hex code for paint / texture_finish
  pattern       TEXT,      -- pattern name for texture_finish
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (zone_id)         -- one material per zone
);

-- ─── COST LINE ITEMS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_line_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  zone_id           UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  zone_type         zone_type NOT NULL,
  material_type     material_type NOT NULL,
  measurement       NUMERIC(10, 2) NOT NULL,
  measurement_unit  measurement_unit NOT NULL,
  material_rate     NUMERIC(10, 2) NOT NULL,   -- INR per unit
  material_cost     NUMERIC(12, 2) NOT NULL,
  labor_rate        NUMERIC(10, 2) NOT NULL,   -- INR per unit
  labor_cost        NUMERIC(12, 2) NOT NULL,
  zone_total        NUMERIC(12, 2) NOT NULL,
  liters_needed     NUMERIC(8, 2),             -- paint only
  num_tiles         INTEGER,                   -- tiles only
  color             TEXT,
  pattern           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CREDIT TRANSACTIONS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
  delta         INTEGER NOT NULL,    -- negative = deduct, positive = top up
  reason        TEXT NOT NULL,       -- e.g. "render_requested", "admin_topup"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── UPDATED_AT TRIGGER ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_zones_project_id ON zones(project_id);
CREATE INDEX IF NOT EXISTS idx_zone_materials_project_id ON zone_materials(project_id);
CREATE INDEX IF NOT EXISTS idx_cost_line_items_project_id ON cost_line_items(project_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
