# E2M - AI Exterior House Renovation System Architecture

## Project
AI-Based Exterior House Renovation and Cost Estimation System
For: E2M Solutions - Associate AI Engineer Assessment

---

## STEP 1 - Image Upload and Usability Check

### Input
- User uploads a JPG, PNG, or WebP image of a house exterior
- Any angle, view, lighting, quality is accepted - no hard block on image quality
- Optional: user enters house width in feet on the same screen

### Image validation (frontend, before upload)
- Accepted formats: JPG, PNG, WebP
- Rejected formats: HEIC, BMP, TIFF, and all others
- If wrong format: show inline error immediately, no upload attempted: "Please use a JPG, PNG, or WebP photo. iPhones save as HEIC by default — convert using your phone's share/export option."
- No file size check on frontend — handled on backend

### Image compression (backend, before AI call)
- Claude Vision accepts: JPEG, PNG, GIF, WebP — max 10 MB per image (direct API)
- Gemini accepts: JPEG, PNG, WebP, HEIC, HEIF — max 20 MB total request
- Before sending to Claude: auto-compress using Pillow — resize to max 2048px on longest side, JPEG quality 85
- This brings any normal phone photo (typically 3-12 MB) to under 2 MB
- User never sees this — it just works silently on the backend
- After compression: file is always within Claude's 10 MB limit

### House Width
- Optional field on upload screen
- If provided: AI uses it as primary reference for all area and length estimation
- If skipped: AI falls back to standard door size (7ft x 3ft) as reference, or standard house proportions if door not visible
- Disclaimer shown once before cost breakdown: "Area estimation is approximate. Actual measurements may vary."

### Guidance (not a block)
- Show a tip on the upload screen: "For best results, use a front-facing photo where the main door is visible"
- Reason: area estimation uses the standard door (7ft x 3ft) as a size reference. If door is not visible, estimation is less accurate but the pipeline still runs.

### AI Usability Check
- After upload, Claude Vision checks: is this image recognizable as a house exterior? Can zones be detected from it?
- If YES: enable Next button, proceed to Step 2
- If NO: disable Next button, show friendly message asking user to try again

### Retry Logic
- Max 2 attempts (1 original + 1 retry)
- On first failure: show message like "We could not read this image clearly. Please try a clearer photo."
- On second failure: do NOT hard block. Show warning: "Image quality is low - zone detection may be inaccurate. Proceed anyway?" with a Proceed button.
- Reason: never fully block a user, especially in a demo. Evaluators will hit that wall.

---

## STEP 2 - Zone Detection

### How it works
- Same AI call as Step 1 (no extra API call for usability check + zone detection - combined into one)
- Claude Vision detects all visible zones from the image
- Windows are NOT shown to user as a selectable zone and wall area is NOT reduced for window openings (see Windows - ELIMINATED below)

### One zone = one material (locked decision)
- Each zone gets exactly one material applied
- Zones are defined granularly so no zone needs two materials
- Example: balcony is split into balcony floor and balcony railing - not kept as one broad zone

### 8 Detectable Zones

| Zone | Material Options |
|---|---|
| Main walls | paint / stone cladding / texture finish / panels |
| Columns and pillars | paint / stone cladding |
| Parapet wall | paint / texture finish |
| Balcony floor | tiles |
| Balcony railing | glass railing / metal railing |
| Gate grille | metal railing |
| Gate boundary wall | paint / stone cladding |
| Roof edge railing | glass railing / metal railing |

### Windows - ELIMINATED (deliberate decision)
- The requirements document (section 5.2) lists windows as a detectable component.
- We detect windows internally to understand wall context but do not expose them as a user-facing zone and do not subtract window area from wall measurements.
- Reason: estimating window area from a single 2D photo is unreliable. The AI cannot accurately determine window dimensions from perspective alone. A wrong subtraction introduces a larger error than a slight overestimate of wall area.
- Result: wall area is used as-is without subtracting window openings.
- Limitation documented: "Window and door openings are not subtracted from wall area. Actual material required may be 10-15% lower than estimated."

### Zone Detection Measurement Types

| Zone | Measurement Type | Unit |
|---|---|---|
| Main walls | Area | sqft |
| Columns and pillars | Area | sqft |
| Parapet wall | Area | sqft |
| Balcony floor | Area | sqft |
| Balcony railing | Linear | linear ft |
| Gate grille | Count | number |
| Gate boundary wall | Area | sqft |
| Roof edge railing | Linear | linear ft |

### What the AI prompt needs to cover (prompt to be written during dev)

Part 1 - Usability check guidance
- What makes an image acceptable: recognizable house exterior, at least some zones detectable
- What makes it unacceptable: too blurry, not a house, completely obscured

Part 2 - Zone detection guidance
- Which 8 zones to look for
- What each zone looks like visually so AI knows what to detect
- No window detection needed

Part 3 - Measurement guidance
- Which zones need area, which need linear ft, which need count
- If house width provided by user: use it as primary reference
- If not provided: use door (7ft x 3ft) as reference
- If door not visible: use standard house proportions as best guess
- All estimation is approximate

Part 4 - Output format
- Only detected zones are returned
- For each detected zone: zone name, measurement value, measurement unit
- Confidence score used internally only, not shown to user

---

## STEP 3 - HITL Zone Review

### Layout
Two-column layout:
- Left column: original uploaded photo (fixed, non-interactive, scrollable if tall)
- Right column: zone list
- On mobile: photo stacks above the zone list
- Purpose: user can glance at their house while reviewing and editing zone measurements

### What the user sees
A list of all detected zones on the right. Each row shows:
- Zone name (editable via dropdown)
- Measurement value (editable number field)
- Measurement unit (read only, auto-set by zone type, not user editable)
- Delete button

### User actions allowed
1. Leave as is and proceed
2. Delete a zone entirely
3. Add a new zone from dropdown
4. Edit zone type
5. Edit measurement value

### Measurement unit rule
- Unit is determined by zone type, not by user
- Main walls, columns, parapet wall, balcony floor, gate boundary wall = sqft
- Balcony railing, roof edge railing = linear ft
- Gate grille = count (whole number only)
- If user changes zone type, unit auto-updates. Unit field is always read only.

### Add zone logic
- Dropdown shows only zones not already in the list
- When zone is selected from dropdown, unit auto-fills (read only)
- Value field starts empty, user must fill it
- Row cannot be saved until zone is selected and value is valid
- Once added, zone disappears from dropdown

### Delete zone logic
- Zone is removed from list
- Zone immediately reappears in add dropdown

### Edit zone type logic
- Dropdown shows only zones not already in list, plus the current row's own zone
- When type changes, unit auto-updates and value resets to empty

### Validation rules
- At least 1 zone must exist to enable Next button. If all deleted, Next is disabled.
- Value cannot be empty
- Value cannot be zero
- Value cannot be negative
- Gate grille (count type): must be a whole number, no decimals
- All other zones: positive decimal allowed

---

## STEP 4 - Material Selection

### Tier decision
- User selects one global tier for the whole project: Economy / Standard / Premium
- To help decide, a "View Catalog" button opens a popup

### View Catalog popup
- 3 tier tabs/buttons at top: Economy / Standard / Premium
- Click a tier to see all materials under it
- Each material card shows: thumbnail image, rate, and specs
- Specs include: durability (lifespan), maintenance requirement, best suited for
- Example: Paint Economy — "Repaint every 5-7 years. Low cost, easy maintenance."
- Example: Stone Cladding Premium — "20+ year lifespan. Zero maintenance. Weatherproof."
- Specs to be sourced from manufacturer/brand websites during dev
- Clean polished UI
- User browses, understands what each tier offers including maintenance implications
- Closes popup and comes back to the page to make selection

### Zone list on the page
- Shows all confirmed zones from Step 3
- User selects tier once at the top, prices auto-update across all rows
- Per zone row: material dropdown shows only applicable materials for that zone
- Auto-applied zones (balcony floor = tiles, gate grille = metal gate): no dropdown, material shown as text
- After material is selected, sub-choices appear inline in that row (color/pattern for applicable materials)
- No irrelevant options shown anywhere

### Material options per zone
| Zone | Options |
|---|---|
| Main walls | paint / stone cladding / texture finish / panels |
| Columns and pillars | paint / stone cladding |
| Parapet wall | paint / texture finish |
| Balcony floor | tiles (auto-applied) |
| Balcony railing | glass railing / metal railing |
| Gate grille | metal gate (auto-applied) |
| Gate boundary wall | paint / stone cladding |
| Roof edge railing | glass railing / metal railing |

---

### Paint

**Zones:** Main walls / Columns / Parapet wall / Gate boundary wall

**User choice:** Color swatch — appears inline after paint selected. Required before Next enabled.

**Color palette (15 options — independent of tier)**
| # | Name | Hex |
|---|---|---|
| 1 | Ivory White | #F8F4E8 |
| 2 | Warm Cream | #F5E6C8 |
| 3 | Butter Yellow | #F5D78E |
| 4 | Ochre / Mustard | #C8A84B |
| 5 | Peach | #F0A878 |
| 6 | Terracotta | #C4623A |
| 7 | Light Pink | #F2C4C4 |
| 8 | Sand / Beige | #D4B896 |
| 9 | Warm Brown | #8B6347 |
| 10 | Sky Blue | #A8C5D8 |
| 11 | Deep Teal | #3D7A8A |
| 12 | Soft Grey | #C5C5C5 |
| 13 | Charcoal | #4A4A4A |
| 14 | Sage Green | #9CAF88 |
| 15 | Mint Green | #A8D5B5 |

**UI:** Inline color swatch grid in zone row. Selected swatch + name stays visible. All zone colors visible together by scanning the list — this is the combination preview. No separate preview screen needed.

**Render prompt:** "Apply [color name] paint to [zone name]"

**PDF:** Zone | Material | Tier | Color | Quantity | Unit

**Sourcing:** None — flat hex colors in CSS

---

### Texture Finish

**Zones:** Main walls / Parapet wall only

**User choice:** Color (same 15 palette) + Pattern — both required before Next enabled. Color and pattern independent of tier.

**Patterns (5 options — shown as thumbnail images with name)**
| Pattern | Description |
|---|---|
| Sand | Fine gritty surface — most common Indian exterior |
| Bark | Vertical linear grooves — popular modern look |
| Pebble | Rough stone-dash surface — traditional |
| Sponge | Soft mottled pattern — subtle |
| Smooth | Flat finish — no texture |

**UI:** Inline color swatch grid + pattern thumbnail grid in zone row. Both selections stay visible after choosing.

**Render prompt:** "Apply [color] [pattern] texture finish to [zone]"

**PDF:** Zone | Material | Tier | Color | Pattern | Quantity | Unit

**Sourcing:** 5 texture pattern thumbnail photos — Unsplash ("sand wall texture", "bark finish wall" etc.)

---

### Stone Cladding

**Zones:** Main walls / Columns / Gate boundary wall

**User choice:** None — default per tier passed to Gemini automatically

| Tier | Default for Gemini |
|---|---|
| Economy | Natural grey slate |
| Standard | Warm yellow-brown sandstone |
| Premium | Dark grey granite |

**UI:** No sub-choice. Catalog shows 1 representative photo per tier so user knows what they get.

**Render prompt:** "Apply [default] stone cladding to [zone]"

**PDF:** Zone | Material | Tier | Quantity | Unit

**Sourcing:** 3 catalog photos (one per tier) — Unsplash / zenstone.in

**Phase 2:** Shade selection per zone

---

### Tiles

**Zone:** Balcony floor only — auto-applied

**User choice:** None — default per tier

| Tier | Default for Gemini |
|---|---|
| Economy | Plain light grey ceramic tile |
| Standard | Light grey vitrified tile |
| Premium | Large format beige/grey tile |

**UI:** Auto-applied text, no dropdown, no sub-choice. Catalog shows 1 photo per tier.

**Render prompt:** "Apply [default] tiles to balcony floor"

**PDF:** Zone | Material | Tier | Quantity (sqft) | Number of tiles | Unit

**Sourcing:** 3 catalog photos — tile brand websites / comaron.com

**Phase 2:** Design/color selection

---

### ACP Panels

**Zone:** Main walls only

**User choice:** None — default per tier

| Tier | Default for Gemini |
|---|---|
| Economy | White plain ACP |
| Standard | Silver ACP |
| Premium | Dark grey architectural ACP |

**UI:** No sub-choice. Catalog shows 1 photo per tier.

**Render prompt:** "Apply [default] ACP panels to main walls"

**PDF:** Zone | Material | Tier | Quantity | Unit

**Sourcing:** 3 catalog photos — vivaacp.com / aludecor.com

**Phase 2:** Pattern (plain / wood grain / brushed metal) + color

---

### Glass Railing

**Zones:** Balcony railing / Roof edge railing

**User choice:** None — default per tier

| Tier | Default for Gemini |
|---|---|
| Economy | Clear glass, silver aluminium frame |
| Standard | Clear glass, semi-frameless silver posts |
| Premium | Frameless clear glass, SS 304 fittings |

**UI:** No sub-choice. Catalog shows 1 photo per tier.

**Render prompt:** "Apply [default] glass railing to [zone]"

**PDF:** Zone | Material | Tier | Quantity (linear ft) | Unit

**Sourcing:** 3 catalog photos — imperiorailing.com

**Phase 2:** Glass type (clear/frosted/tinted) + frame color for Economy/Standard

---

### Metal Railing

**Zones:** Balcony railing / Roof edge railing

**User choice:** None — default per tier

| Tier | Default for Gemini |
|---|---|
| Economy | Black powder coated plain MS railing |
| Standard | Black powder coated designed MS railing |
| Premium | Brushed silver SS 304 railing |

**UI:** No sub-choice. Catalog shows 1 photo per tier.

**Render prompt:** "Apply [default] metal railing to [zone]"

**PDF:** Zone | Material | Tier | Quantity (linear ft) | Unit

**Sourcing:** 3 catalog photos — grillwale.com

**Phase 2:** Powder coat color (Economy/Standard only)

---

### Gate Grille

**Zone:** Gate grille only — auto-applied

**User choice:** None — default per tier

| Tier | Default for Gemini |
|---|---|
| Economy | Black powder coated MS single leaf gate |
| Standard | Black powder coated MS double leaf gate |
| Premium | Brushed silver SS 304 double leaf gate |

**UI:** Auto-applied text, no sub-choice. Catalog shows 1 photo per tier.

**Render prompt:** "Apply [default] gate to gate grille area"

**PDF:** Zone | Material | Tier | Quantity (count) | Unit

**Sourcing:** 3 catalog photos — grillwale.com

**Phase 2:** Powder coat color (Economy/Standard only)

---

### Image Sourcing Task (complete before frontend dev)
| Material | Photos needed | Source |
|---|---|---|
| Texture finish patterns | 5 | Unsplash |
| Stone cladding | 3 | Unsplash / zenstone.in |
| Tiles | 3 | Tile brand websites / comaron.com |
| ACP panels | 3 | vivaacp.com / aludecor.com |
| Glass railing | 3 | imperiorailing.com |
| Metal railing | 3 | grillwale.com |
| Gate grille | 3 | grillwale.com |
| Paint | 0 | CSS hex only |
| **Total** | **23 photos** | |

---

### Step 4 Validation
- Paint zone selected + color not chosen → Next disabled
- Texture finish zone selected + color or pattern not chosen → Next disabled
- All other materials → no sub-choice required → Next enabled once all zones have a material selected

### Multiple combinations and design switching (out of scope for prototype)
- The requirements document (section 5.3) mentions previewing multiple combinations and switching between designs.
- For the 48-hour prototype: one design combination is supported per project, with one retry allowed.
- The retry flow (go back to Step 4, change materials, re-render) gives the user one round of design switching within a project.
- Saving and comparing multiple full design combinations is a Phase 2 feature — it requires storing multiple render outputs and cost breakdowns per project, which is out of scope for the assessment deadline.

---

## STEP 5 - Render

### When it runs
- After Step 4 (material selection) is confirmed
- Gemini generates a photorealistic render of the house with selected materials applied

### Final results page layout
- Rendered image shown at top
- Compare button toggles between single view and side-by-side with original image
- Side by side not shown by default - keeps page clean
- Grand total shown below image
- "View Breakdown" button opens cost popup

### Render prompt must cover
1. Preserve original house structure exactly: shape, proportions, windows, doors, architectural elements, perspective, angle, lighting
2. Apply each selected material to each specific zone (every zone listed with material type and tier)
3. Photorealistic output - not a cartoon or illustration
4. Do not add or remove any architectural elements
5. On retry: append user notes about what to fix

### Retry logic
- Max 2 renders total per project (1 original + 1 retry)
- If user is not satisfied with render:
  - User can optionally go back to Step 4 and change materials
  - User must write notes about what went wrong (required field, cannot retry without it)
  - Both updated materials + user notes are fed into the retry render prompt together
  - This gives Gemini maximum context for a better result
- After 1 retry: retry button permanently disabled
- Message shown: "Maximum retries reached. Start a new project to try again."
- No exceptions - max 2 renders per project regardless

### Going back to Step 4
- Allowed only for retry purposes
- User goes back, changes materials, returns to final page, hits retry
- This counts as the 1 allowed retry
- State is fully preserved (image, zones, measurements) - user does not lose work
- After retry is used: cannot go back to Step 4 again

---

## STEP 6 - Area Estimation

### How it works
- Area estimation happens as part of the same AI call in Step 2 (zone detection)
- No separate step or API call

### Reference logic
- If user provided house width: AI uses it as primary reference for all proportions
- If not provided: AI uses standard door (7ft x 3ft) as reference
- If door not visible: AI uses standard house proportions as best guess

### Output per zone
- Main walls: sqft
- Columns and pillars: sqft
- Parapet wall: sqft
- Balcony floor: sqft
- Balcony railing: linear ft
- Gate grille: count
- Gate boundary wall: sqft
- Roof edge railing: linear ft

### Limitation
- All estimation is approximate from a single 2D photo
- Window and door openings not subtracted from wall area
- Disclaimer shown on final page: "Area estimation is approximate. Actual measurements may vary."

---

## STEP 7 - Cost Calculation + Final Results Page

### Final page layout
- Render image (before + after) shown at top
- Grand total shown prominently below image
- "View Breakdown" button opens a popup with full zone-by-zone cost table
- Main page stays clean and uncluttered

### Cost breakdown popup
- Zone-by-zone table
- All numeric values are editable inline (no separate edit mode)
- Each editable field has a pencil/edit icon for clarity
- When any value is changed, all dependent values and grand total auto-recalculate instantly (no button, no reload)
- Hint text shown: "Edit values to match your local contractor quotes"

### What is editable
All numeric values per zone:
- Measurement / count (sqft, linear ft, or count)
- Material rate (INR per liter / per sqft / per lft / per unit)
- Labor rate (INR per sqft / per lft / per unit)

### What is NOT editable
- Material type (locked after Step 4)
- Wastage % (system fixed, not shown to user)
- Coverage for paint (system fixed, not shown to user)

### Validation on editable fields
- Cannot be empty
- Cannot be zero
- Cannot be negative
- Count fields (gate grille): must be whole number, no decimals

### Core calculation rules
- Labor is always calculated on net detected area/length, NOT on wastage-adjusted quantity
- Wastage only affects material quantity and cost, not labor
- All area materials (paint, texture finish, stone cladding, tiles, panels): rate stored in INR per sqft
- Railing materials: rate stored in INR per linear ft
- Gate grille: rate stored in INR per unit
- Paint also outputs liters needed as a display value (quantity with wastage / 100) so user knows how many cans to buy

### Formula 1 - Paint
```
net area = zone sqft (no window subtraction)
quantity with wastage = net area x 1.10
material cost = quantity with wastage x rate (INR/sqft)
labor cost = net area x 30
zone total = material cost + labor cost
display output: liters needed = quantity with wastage / 100  (for user reference only, not used in cost)
```
Note: paint rate is stored as INR/sqft (effective rate per sqft including all coats and contractor supply markup).
Liters needed is shown so the user knows how many cans to buy, but cost is always calculated per sqft like all other area materials.

### Formula 2 - Texture Finish
```
net area = zone sqft
quantity with wastage = net area x 1.10
material cost = quantity with wastage x rate (INR/sqft)
labor cost = net area x 50
zone total = material cost + labor cost
```

### Formula 3 - Stone Cladding
```
net area = zone sqft
quantity with wastage = net area x 1.15
material cost = quantity with wastage x rate (INR/sqft)
labor cost = net area x 100
zone total = material cost + labor cost
```

### Formula 4 - Tiles
```
net area = balcony floor sqft
quantity with wastage = net area x 1.10
material cost = quantity with wastage x rate (INR/sqft)
labor cost = net area x 50
zone total = material cost + labor cost

number of tiles = ceil(quantity with wastage / sqft per tile)
  Economy and Standard tier (600x600mm): sqft per tile = 3.9
  Premium tier (600x1200mm): sqft per tile = 7.75
display output: number of tiles needed
```

### Formula 5 - Panels (ACP)
```
net area = zone sqft
quantity with wastage = net area x 1.10
material cost = quantity with wastage x rate (INR/sqft)
labor cost = net area x 30
zone total = material cost + labor cost
```

### Formula 6 - Glass Railing
```
net length = zone linear ft
quantity with wastage = net length x 1.05
material cost = quantity with wastage x rate (INR/lft)
labor cost = net length x 800
zone total = material cost + labor cost
```

### Formula 7 - Metal Railing
```
net length = zone linear ft
quantity with wastage = net length x 1.05
material cost = quantity with wastage x rate (INR/lft)
labor cost = net length x 150
zone total = material cost + labor cost
```

### Formula 8 - Gate Grille
```
quantity = count (no wastage)
material cost = quantity x rate (INR/unit)
labor cost = quantity x 600
zone total = material cost + labor cost
```

### Grand Total
```
total material cost = sum of all zone material costs
total labor cost = sum of all zone labor costs
grand total = total material cost + total labor cost
```

### Known Limitation
Window and door openings are not subtracted from wall area. Actual material required may be 10-15% lower than estimated. Documented in system limitations.

---

## STEP 8 - PDF Report

### When it is available
- Only after project status = "completed" (render done, cost calculated)
- "Download Report" button on the final results page
- Button is disabled and greyed out until project is completed

### What triggers generation
- User clicks "Download Report"
- Frontend calls GET /projects/{id}/report
- Backend generates PDF on demand and returns it as a file download
- No pre-generation or caching — generated fresh each time so it always reflects current values including any inline edits the user made

### File naming
- renovation_report_{project_id}_{YYYY-MM-DD}.pdf

### Report structure (4 pages)

**Page 1 — Cover**
- Title: "Exterior Renovation Estimate"
- Date generated
- Original uploaded photo on the left
- Rendered redesign image on the right
- Both images same size, side by side

**Page 2 — Design Summary**
- Table: Zone | Material Selected | Tier | Quantity | Unit
- One row per confirmed zone
- Header row in bold

**Page 3 — Cost Breakdown**
- Table: Zone | Material | Quantity | Unit | Material Rate | Material Cost | Labor Rate | Labor Cost | Zone Total
- One row per zone
- Subtotal rows at bottom: Total Material Cost | Total Labor Cost | Grand Total
- Grand Total row highlighted

**Page 4 — Notes and Disclaimer**
- "Rates are indicative market averages as of 2026. Actual costs vary by location, contractor, and market conditions."
- "Area estimation is approximate. Window and door openings are not subtracted from wall area. Actual material required may be 10-15% lower than estimated."
- "This report is for planning purposes only and is not a legally binding quotation."
- "Generated by E2M Exterior Renovation Estimator."

### Library choice
- ReportLab (pure Python, no system binary dependencies)
- Reason: WeasyPrint requires Cairo/Pango system libraries which are unreliable to install on Railway/Render. ReportLab works on any Python environment with pip install only.

### Backend endpoint
- GET /projects/{id}/report
- Validates: project belongs to current user + status = completed
- Fetches: zones, materials, tier, measurements, cost breakdown from DB
- Fetches: original image URL + render image URL from DB
- Downloads both images into memory (not disk)
- Generates PDF in memory using ReportLab
- Returns: PDF file as streaming response with Content-Disposition: attachment

### Inline edit and PDF consistency
- User can edit cost values inline on the final page
- Inline edits are auto-saved to DB immediately on change (no separate save button)
- PDF always fetches from DB at generation time
- So PDF always reflects the user's latest values including any edits made to rates or measurements

### Credit cost
- PDF generation does not cost a credit (no AI call involved)
- User can download as many times as they want

---

## Non-Functional Requirements

### Usability
- Designed for non-technical users: no jargon, friendly error messages, guided step-by-step flow
- Every action has a visible label — no icon-only buttons

### Loading states
- Zone detection (Step 2) and render (Step 5) are the two slow AI calls
- Both show a full-page loading overlay with a message: "Analyzing your house... this takes a few seconds"
- User cannot interact with the page or navigate away during an AI call
- All other steps (HITL, material selection, cost view) are instant — DB reads only, no spinner needed

### Timeouts
- If an AI call does not respond within 60 seconds: show error message, roll back project status to previous stable state
- Credit is NOT deducted on timeout (atomic transaction — AI result was never saved so credit never deducted)
- User is shown: "Something went wrong. Please try again."

### Target response times (estimates — to be confirmed during testing)
- Zone detection: expected 15-30 seconds depending on Claude model response time
- Render: expected 20-45 seconds depending on Gemini model response time
- All non-AI steps: under 1 second (DB reads)
- PDF generation: under 5 seconds

### Network
- Standard broadband or mobile internet is sufficient
- No large files transferred except image upload (original photo) and render download (generated image)
- Image upload: user's original photo, typically 1-5 MB
- Render download: Gemini output image, typically under 2 MB

### Concurrency
- Each user's data is fully isolated by user UUID in Supabase
- No shared state between users
- Supabase handles concurrent reads and writes — no custom locking needed
- Multiple users can run zone detection or renders simultaneously without affecting each other

### Re-editing and saving
- Project state is saved after every step
- User can leave and return at any point — work is never lost
- In-progress projects resume from the last completed step

---

## Authentication and Authorization

### Method
- Google OAuth only (reuse KABS auth code)
- Email/password not included in demo - can be added in production
- Each user gets a deterministic UUID from their Google sub

### Multiple users
- Fully isolated by user UUID
- Each user sees only their own projects

---

## Project Saving and State Management

### When to save
- After Step 2 complete: save detected zones + measurements
- After Step 3 complete: save confirmed zones
- After Step 4 complete: save material selections + tier
- After Step 5 complete: save render image URL + cost breakdown
- State is always preserved - user can leave and return anytime

### Project status field in DB
```
pending → detecting → hitl → material_selection → rendering → completed
```

### Mid-session interruption handling
- If status is `detecting` on return: rollback to `pending`, show "Session interrupted. Retry from Step 1."
- If status is `rendering` on return: rollback to `material_selection`, show "Session interrupted. Retry render from Step 4."
- Partial/failed AI output discarded on rollback
- DB never holds corrupt or incomplete step data

### Starting new project from mid-save
- Dashboard always accessible
- New Project button always available regardless of in-progress project
- In-progress project stays saved, user can return to it from dashboard

---

## Dashboard

### Contents
- New Project button (prominent)
- Credits remaining counter
- Project list per user:
  - Render thumbnail
  - Date created
  - Total cost
  - Status (in progress / completed)
- Click any project to resume or view

---

## Navigation

### In-app navigation
- Steps 3 and 4 (HITL + material selection): free back and forward, no AI triggered
- Cannot go back to Step 1 or 2 from anywhere (would re-run AI)
- Retry flow: final page → Step 4 → optionally Step 3 → re-render (counts as 1 retry)
- Changes in Step 3 or 4 during retry reflect in cost after re-render

### Browser back/forward buttons
- Cannot be fully blocked (browser security prevents this)
- `useBlocker` in React Router: shows confirmation dialog before navigating away
- `window.onbeforeunload`: shows native "Leave site?" popup on tab close or refresh
- Data is safe regardless since we save after each step

---

## Credits System

### Decision
- Mock credit system, no real payment
- Credits stored in DB per user
- No Stripe or payment gateway needed for demo

### Credits on signup
- Each user gets 5-7 free credits on signup (exact number TBD)

### What costs credits
- 1 credit per successful AI call
- Claude Vision call completes successfully: deduct 1 credit
- Gemini render completes successfully: deduct 1 credit
- Maximum 3 credits per project (1 detection + 2 renders)

### When to deduct
- Deduct credit in the SAME DB transaction as saving the AI result
- Atomic operation: save AI result + deduct credit = one transaction
- Either both happen or neither happens
- No gap, no race condition, no refund logic needed
- This is the standard production approach

### Known limitation
- AI call is external and happens before the DB transaction
- If DB transaction fails after AI call completes, API cost is incurred but credit is not deducted
- This is an infrastructure failure scenario, extremely rare in practice
- Acceptable risk for demo scope
- In production: solved with idempotency keys + job queue (out of scope for 48hrs)

### UI
- Credits counter always visible in header
- Before each AI call: show "This will use 1 credit. You have X remaining."
- On zero credits:
  - Disable all action buttons that trigger AI calls (upload/detect button, render button)
  - Show message: "You have no credits left. Contact us for more."
  - User can still view existing completed projects from dashboard

### Why not unlimited
- One user can drain all API budget with unlimited runs in a real product
- Mock credits show awareness of this without over-engineering

### Why not real payment
- Too complex for 48hr deadline
- Out of scope for an assessment

---

## Materials Catalogue

### 7 materials supported
1. Paint (rate: INR per sqft — effective rate; liters needed shown separately as display output)
2. Stone Cladding (rate: INR per sqft)
3. Tiles (rate: INR per sqft, also outputs number of tiles)
4. Texture Finish (rate: INR per sqft)
5. Glass Railing (rate: INR per linear ft)
6. Metal Railing (rate: INR per linear ft)
7. Panels (rate: INR per sqft)

### Catalogue approach
- Hardcoded with real brand names and real approximate INR market rates
- No scraping
- 3 tiers x 7 materials = 21 catalogue entries
- Documentation note: "Rates are indicative market averages as of 2026"

### Wastage percentages (research-verified, India standard)
Source: infralens.in/knowledge/construction-material-wastage-factors-india + trybuildcalc.com/knowledge/material/construction-material-wastage-guide

| Material | Wastage % | Basis |
|---|---|---|
| Paint | 10% | CPWD standard, excess and over-application |
| Texture finish | 10% | Same as paint, surface prep loss |
| Stone cladding | 15% | Cutting at corners and edges, IS/CPWD practice |
| Tiles | 10% | Straight lay standard, cutting and breakage |
| Panels | 10% | Cutting waste at edges |
| Glass railing | 5% | Pre-cut supply, minimal site waste |
| Metal railing | 5% | Pre-fabricated, minimal site waste |
| Gate grille | 0% | Whole unit, counted as-is |

### Paint coverage
- 100 sqft per liter (practical, 2 coats)
- Source: nobroker.in/forum/how-much-is-exterior-paint-coverage + Asian Paints Apex Weatherproof spec sheet (theoretical 110-130 sqft/liter, practical 100 sqft/liter used as conservative standard)

### Labor rates (research-verified, India 2026)
- Fixed per material type, same across all tiers
- Labor cost does not change by tier - only material cost changes by tier
- Source: comaron.com/blog/construction-labor-cost-per-sq-ft-india-2026 + aecord.com/blog/labour-rates-for-house-construction-india-2026 + imperiorailing.com + grillwale.com/pages/pricelist

| Material | Labor Rate | Source |
|---|---|---|
| Paint | Rs 30 per sqft | comaron.com (actual range Rs 25-45/sqft) |
| Texture finish | Rs 50 per sqft | aapkapainter.com (actual range Rs 40-70/sqft) |
| Stone cladding | Rs 100 per sqft | aecord.com (actual range Rs 80-120/sqft) |
| Tiles | Rs 50 per sqft | comaron.com (actual range Rs 45-90/sqft) |
| Panels | Rs 30 per sqft | pioneerpanels.com (actual range Rs 25-40/sqft) |
| Glass railing | Rs 800 per linear ft | imperiorailing.com (actual range Rs 500-1500/lft) |
| Metal railing | Rs 150 per linear ft | grillwale.com (actual range Rs 120-200/lft) |
| Gate grille | Rs 600 per unit | grillwale.com (installation, standard single leaf) |

### Material rates per tier (research-verified, India 2026)
Material cost only. Labor is separate (see above). All rates are indicative market averages as of 2026.

#### Paint (INR per sqft, effective rate — all coats + contractor supply markup)
Source: aapkapainter.com/products/paints/asian-paints-price + nobroker.in/blog/berger-paint-price-1-liter
| Tier | Brand | Rate |
|---|---|---|
| Economy | Berger Weathercoat Glow | Rs 18/sqft |
| Standard | Asian Paints Apex Weatherproof | Rs 28/sqft |
| Premium | Berger Weathercoat Long Life | Rs 45/sqft |

#### Texture Finish (per sqft)
Source: aapkapainter.com/blog/texture-paint-everything-you-need-to-know + nobroker.in/painting-services/home-painting-ideas/texture-paint-price
| Tier | Brand | Rate |
|---|---|---|
| Economy | Berger Walmasta Texture | Rs 35/sqft |
| Standard | Asian Paints Apex Duracast | Rs 60/sqft |
| Premium | Dulux Weathershield Texture | Rs 90/sqft |

#### Stone Cladding (per sqft)
Source: zenstone.in/stone-wall-cladding-price-in-2026 + arslanstonex.com/natural-stone-wall-cladding
| Tier | Type | Rate |
|---|---|---|
| Economy | Slate / Kota Stone | Rs 100/sqft |
| Standard | Sandstone / Ledger Stone | Rs 200/sqft |
| Premium | Granite Cladding | Rs 380/sqft |

#### Tiles - Balcony Floor (per sqft)
Source: comaron.com/blog/tiles-price-india-2026 + buildingandinteriors.com/kajaria-floor-tiles
| Tier | Brand | Rate |
|---|---|---|
| Economy | Kajaria Ceramic 600x600 | Rs 45/sqft |
| Standard | Kajaria Vitrified 600x600 | Rs 85/sqft |
| Premium | Johnson GVT Large Format | Rs 150/sqft |

#### Panels - ACP (per sqft)
Source: vivaacp.com/acp-sheet-price/rate-card + pioneerpanels.com/what-is-the-price-of-acp-sheets-with-fitting
| Tier | Brand | Rate |
|---|---|---|
| Economy | Viva 3mm PE | Rs 90/sqft |
| Standard | Viva 4mm PVDF | Rs 150/sqft |
| Premium | Aludecor 4mm PVDF Architectural | Rs 220/sqft |

#### Glass Railing (per linear ft)
Source: imperiorailing.com/our-blog/glass-railing-price-in-india + jivialrailings.com/blog/glass-railing-cost-per-sq-ft-india
| Tier | Type | Rate |
|---|---|---|
| Economy | Aluminium Framed Glass | Rs 700/lft |
| Standard | Semi-Frameless Glass | Rs 1,500/lft |
| Premium | Frameless Glass SS 304 | Rs 2,500/lft |

#### Metal Railing (per linear ft)
Source: grillwale.com/pages/pricelist (May 2026)
| Tier | Type | Rate |
|---|---|---|
| Economy | MS Powder Coated Plain | Rs 400/lft |
| Standard | MS Powder Coated Designed | Rs 600/lft |
| Premium | SS 304 Railing | Rs 900/lft |

#### Gate Grille (per unit)
Source: grillwale.com/pages/pricelist (May 2026)
| Tier | Type | Rate |
|---|---|---|
| Economy | MS Single Leaf Gate | Rs 10,000 |
| Standard | MS Double Leaf Gate | Rs 20,000 |
| Premium | SS 304 Double Leaf Gate | Rs 40,000 |

---

## Stack
- Backend: FastAPI (reuse from KABS)
- AI Detection: Claude Vision — model: TBD
- AI Rendering: Gemini image generation — model: TBD
- Frontend: React + Vite (reuse from KABS)
- Database: Supabase (PostgreSQL)
- Deployment: Render for both backend (Web Service) and frontend (Static Site)

---

## Project Location
C:\MYWORK\E2M

## Submission
- To: career@e2msolutions.com
- Subject: Associate AI Engineer - Task Submission
- Deliverables: Live prototype link + documentation
