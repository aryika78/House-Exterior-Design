/**
 * MaterialSelectionPage — Step 4: Choose tier + materials per zone
 *
 * 1. Select global tier (Economy / Standard / Premium)
 * 2. Per zone: select material from applicable options
 *    — paint:          choose color (15 swatches) — required
 *    — texture_finish: choose color + pattern     — both required
 *    — balcony_floor / gate_grille: auto-applied, no user choice
 *    — all other materials: no sub-choice needed
 * 3. Confirm → POST /materials (deducts 1 credit, triggers render)
 *    → navigates to /result where polling begins
 *
 * Race-condition guards:
 * - mountedRef prevents setState after unmount
 * - Status guard redirects if project is not at material_selection
 * - Submit button disabled while in-flight; credit deducted server-side atomically
 */
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import {
  ChevronLeft, X, Info, CheckCircle2, Loader2,
  AlertCircle, BookOpen, Zap,
} from 'lucide-react'
import api from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'

// ─── Data ─────────────────────────────────────────────────────────────────────

const PAINT_COLORS = [
  { name: 'Ivory White',     hex: '#F8F4E8' },
  { name: 'Warm Cream',      hex: '#F5E6C8' },
  { name: 'Butter Yellow',   hex: '#F5D78E' },
  { name: 'Ochre / Mustard', hex: '#C8A84B' },
  { name: 'Peach',           hex: '#F0A878' },
  { name: 'Terracotta',      hex: '#C4623A' },
  { name: 'Light Pink',      hex: '#F2C4C4' },
  { name: 'Sand / Beige',    hex: '#D4B896' },
  { name: 'Warm Brown',      hex: '#8B6347' },
  { name: 'Sky Blue',        hex: '#A8C5D8' },
  { name: 'Deep Teal',       hex: '#3D7A8A' },
  { name: 'Soft Grey',       hex: '#C5C5C5' },
  { name: 'Charcoal',        hex: '#4A4A4A' },
  { name: 'Sage Green',      hex: '#9CAF88' },
  { name: 'Mint Green',      hex: '#A8D5B5' },
]

const TEXTURE_PATTERNS = [
  { id: 'sand',   name: 'Sand',   desc: 'Fine gritty surface. Most common Indian exterior finish' },
  { id: 'bark',   name: 'Bark',   desc: 'Vertical linear grooves. Popular modern look' },
  { id: 'pebble', name: 'Pebble', desc: 'Rough stone-dash surface. Traditional finish' },
  { id: 'sponge', name: 'Sponge', desc: 'Soft mottled pattern. Subtle finish' },
  { id: 'smooth', name: 'Smooth', desc: 'Flat finish with no surface relief' },
]

// Which materials are selectable per zone (empty = auto-applied)
const ZONE_MATERIAL_OPTIONS: Record<string, string[]> = {
  main_walls:         ['paint', 'stone_cladding', 'texture_finish', 'acp_panels'],
  columns_pillars:    ['paint', 'stone_cladding'],
  parapet_wall:       ['paint', 'texture_finish'],
  balcony_floor:      [],  // auto → tiles
  balcony_railing:    ['glass_railing', 'metal_railing'],
  gate_grille:        [],  // auto → metal_gate
  gate_boundary_wall: ['paint', 'stone_cladding'],
  roof_edge_railing:  ['glass_railing', 'metal_railing'],
}

const AUTO_MATERIAL: Record<string, string> = {
  balcony_floor: 'tiles',
  gate_grille:   'metal_gate',
}

const MATERIAL_LABEL: Record<string, string> = {
  paint:          'Paint',
  stone_cladding: 'Stone Cladding',
  texture_finish: 'Texture Finish',
  tiles:          'Tiles',
  glass_railing:  'Glass Railing',
  metal_railing:  'Metal Railing',
  acp_panels:     'ACP Panels',
  metal_gate:     'Metal Gate',
}

const ZONE_LABEL: Record<string, string> = {
  main_walls:         'Main Walls',
  columns_pillars:    'Columns & Pillars',
  parapet_wall:       'Parapet Wall',
  balcony_floor:      'Balcony Floor',
  balcony_railing:    'Balcony Railing',
  gate_grille:        'Gate Grille',
  gate_boundary_wall: 'Gate / Boundary Wall',
  roof_edge_railing:  'Roof Edge Railing',
}

const UNIT_LABEL: Record<string, string> = {
  sqft:      'sq ft',
  linear_ft: 'linear ft',
  count:     'units',
}

type Tier = 'economy' | 'standard' | 'premium'

// ─── Catalog data ─────────────────────────────────────────────────────────────

interface CatalogTierEntry {
  rate: number
  durability: string
  maintenance: string
  bestFor: string
}

interface CatalogEntry {
  label: string
  unit: string
  zones: string
  bg: string
  images?: Partial<Record<Tier, string>>
  tiers: Record<Tier, CatalogTierEntry>
}

const CATALOG: Record<string, CatalogEntry> = {
  paint: {
    label: 'Paint', unit: 'per sq ft', bg: 'from-orange-100 to-amber-50',
    images: { economy: '/catalog/paint.jpg', standard: '/catalog/paint.jpg', premium: '/catalog/paint.jpg' },
    zones: 'Main walls · Columns · Parapet wall · Gate boundary wall',
    tiers: {
      economy:  { rate: 18,    durability: '3–5 years',   maintenance: 'Repaint every 3–5 years. Wash annually to remove algae.',             bestFor: 'Budget residential, dry climates, simple surfaces.' },
      standard: { rate: 28,    durability: '5–7 years',   maintenance: 'Repaint every 5–7 years. Clean before monsoon season.',               bestFor: 'Standard residential buildings and mid-rise apartments.' },
      premium:  { rate: 45,    durability: '8–10 years',  maintenance: 'Minimal. Clean every 2 years. Repaint at 8–10 year mark.',            bestFor: 'Premium homes, coastal and high-humidity regions.' },
    },
  },
  texture_finish: {
    label: 'Texture Finish', unit: 'per sq ft', bg: 'from-stone-300 to-stone-200',
    images: { economy: '/catalog/texture-bark.jpg', standard: '/catalog/texture-bark.jpg', premium: '/catalog/texture-bark.jpg' },
    zones: 'Main walls · Parapet wall',
    tiers: {
      economy:  { rate: 35,    durability: '6–8 years',   maintenance: 'Wash with water every year. No repaint needed for 6–8 years.',        bestFor: 'Budget projects wanting a textured look without high outlay.' },
      standard: { rate: 60,    durability: '8–12 years',  maintenance: 'Very low. Washable surface. Refresh at 10-year mark.',                bestFor: 'Mid-range residential, villas, exterior elevations.' },
      premium:  { rate: 90,    durability: '10–15 years', maintenance: 'Minimal. Seal at 10 years. Self-cleaning variants available.',        bestFor: 'Premium homes, branded developer projects, architectural facades.' },
    },
  },
  stone_cladding: {
    label: 'Stone Cladding', unit: 'per sq ft', bg: 'from-[#B5AFA7] to-[#C8BFB5]',
    images: { economy: '/catalog/stone-economy.jpg', standard: '/catalog/stone-standard.jpg', premium: '/catalog/stone-premium.jpg' },
    zones: 'Main walls · Columns · Gate boundary wall',
    tiers: {
      economy:  { rate: 100,   durability: '15–20 years', maintenance: 'Seal every 3–5 years. Clean annually. Inspect grout lines.',          bestFor: 'Budget feature walls, boundary walls, columns.' },
      standard: { rate: 200,   durability: '20–25 years', maintenance: 'Seal every 2–3 years. Porous stone prone to staining without sealant.', bestFor: 'Mid-range residential facades and garden walls.' },
      premium:  { rate: 380,   durability: '25+ years',   maintenance: 'Very low. Clean annually. Seal every 5 years. Near-permanent finish.', bestFor: 'High-end residential, luxury projects, commercial facades.' },
    },
  },
  tiles: {
    label: 'Tiles', unit: 'per sq ft', bg: 'from-gray-200 to-gray-100',
    images: { economy: '/catalog/tiles-economy.jpg', standard: '/catalog/tiles-standard.jpg', premium: '/catalog/tiles-premium.jpg' },
    zones: 'Balcony floor (auto-applied)',
    tiers: {
      economy:  { rate: 45,    durability: '10–15 years', maintenance: 'Easy. Mop cleaning. Re-grout at 8–10 years.',                         bestFor: 'Budget residential balconies and covered semi-outdoor floors.' },
      standard: { rate: 85,    durability: '15–20 years', maintenance: 'Low. Easy cleaning. Very low water absorption (<0.1%).',              bestFor: 'Standard residential balconies and open terraces.' },
      premium:  { rate: 150,   durability: '20–25 years', maintenance: 'Very low. Minimal joints reduce dirt. Seal grout annually.',          bestFor: 'Premium villa balconies, terraces, upscale residential.' },
    },
  },
  acp_panels: {
    label: 'ACP Panels', unit: 'per sq ft', bg: 'from-zinc-300 to-zinc-200',
    images: { economy: '/catalog/acp-economy.jpg', standard: '/catalog/acp-standard.jpg', premium: '/catalog/acp-premium.jpg' },
    zones: 'Main walls',
    tiers: {
      economy:  { rate: 90,    durability: '5–7 years',   maintenance: 'Clean annually with mild detergent. Recoat at 7 years.',              bestFor: 'Semi-covered areas, canopies, signage. Not ideal for full exterior rain exposure.' },
      standard: { rate: 150,   durability: '10–15 years', maintenance: 'Low. Clean bi-annually. PVDF coating resists fading.',                bestFor: 'Full exterior facades, mid-rise building elevations.' },
      premium:  { rate: 220,   durability: '15–20 years', maintenance: 'Very low. Fire-retardant certified. Periodic inspection of joints.',   bestFor: 'High-rise buildings, commercial facades, fire-safety compliant projects.' },
    },
  },
  glass_railing: {
    label: 'Glass Railing', unit: 'per linear ft', bg: 'from-sky-200 to-blue-100',
    images: { economy: '/catalog/glass-economy.jpg', standard: '/catalog/glass-standard.jpg', premium: '/catalog/glass-premium.jpg' },
    zones: 'Balcony railing · Roof edge railing',
    tiers: {
      economy:  { rate: 700,   durability: '10–15 years', maintenance: 'Clean glass monthly. Check frame paint/anodising every 3 years.',     bestFor: 'Budget apartments, standard residential balconies.' },
      standard: { rate: 1500,  durability: '15–20 years', maintenance: 'Low. Clean glass fortnightly. Inspect SS fittings annually.',         bestFor: 'Mid-range residential, apartment balconies, terraces.' },
      premium:  { rate: 2500,  durability: '20–25 years', maintenance: 'Very low. Clean glass weekly. Inspect U-channel seals annually.',     bestFor: 'Premium villas, luxury apartments, sea-facing and pool-deck balconies.' },
    },
  },
  metal_railing: {
    label: 'Metal Railing', unit: 'per linear ft', bg: 'from-neutral-400 to-neutral-300',
    images: { economy: '/catalog/metal-economy.jpg', standard: '/catalog/metal-standard.jpg', premium: '/catalog/metal-premium.jpg' },
    zones: 'Balcony railing · Roof edge railing',
    tiers: {
      economy:  { rate: 400,   durability: '8–12 years',  maintenance: 'Repaint / touch-up every 3–5 years. Inspect welds annually.',         bestFor: 'Budget residential, interior balconies, non-coastal locations.' },
      standard: { rate: 600,   durability: '8–12 years',  maintenance: 'Repaint every 3–5 years. Ornamental design — clean quarterly.',       bestFor: 'Mid-range residential with decorative requirements.' },
      premium:  { rate: 900,   durability: '20–30 years', maintenance: 'Very low. Clean monthly. No painting ever required.',                  bestFor: 'Premium residential, coastal locations, long-term installations.' },
    },
  },
  metal_gate: {
    label: 'Gate', unit: 'per unit', bg: 'from-neutral-500 to-neutral-400',
    images: { economy: '/catalog/gate-economy.jpg', standard: '/catalog/gate-standard.jpg', premium: '/catalog/gate-premium.jpg' },
    zones: 'Gate grille (auto-applied)',
    tiers: {
      economy:  { rate: 10000, durability: '8–12 years',  maintenance: 'Repaint every 3–5 years. Oil hinges annually. Inspect welds.',        bestFor: 'Residential compound entry — single opening / pedestrian gate.' },
      standard: { rate: 20000, durability: '10–15 years', maintenance: 'Repaint every 4–5 years. Check gate alignment and hinges annually.',  bestFor: 'Main vehicular + pedestrian compound gates, mid-range residential.' },
      premium:  { rate: 40000, durability: '20–25 years', maintenance: 'Very low. Polish annually. Check auto-operator if motorised.',        bestFor: 'Premium residential main gates, upscale compound entries.' },
    },
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ZoneSel {
  material_type: string
  color?: string
  pattern?: string
}

function isZoneComplete(zone_type: string, sel: ZoneSel | undefined): boolean {
  if (AUTO_MATERIAL[zone_type]) return true   // auto-applied = always valid
  if (!sel?.material_type) return false
  if (sel.material_type === 'paint' && !sel.color) return false
  if (sel.material_type === 'texture_finish' && (!sel.color || !sel.pattern)) return false
  return true
}

// ─── CatalogPopup ─────────────────────────────────────────────────────────────

type CatalogStep = 'tier' | 'materials' | 'detail'

const TIER_STYLES: Record<Tier, { border: string }> = {
  economy:  { border: 'border-[#E8E1D8]' },
  standard: { border: 'border-blue-200'  },
  premium:  { border: 'border-amber-200' },
}

function CatalogPopup({ defaultTier, onClose }: { defaultTier: Tier | null; onClose: () => void }) {
  const [step, setStep]               = useState<CatalogStep>(defaultTier ? 'materials' : 'tier')
  const [tier, setTier]               = useState<Tier | null>(defaultTier)
  const [selectedMat, setSelectedMat] = useState<string | null>(null)
  const [dir, setDir]                 = useState<1 | -1>(1) // 1=forward, -1=back

  const goBack = () => {
    setDir(-1)
    if (step === 'detail')         { setSelectedMat(null); setStep('materials') }
    else if (step === 'materials') { setTier(null);        setStep('tier')      }
  }

  const selectTier = (t: Tier)   => { setDir(1); setTier(t); setStep('materials') }
  const selectMat  = (k: string) => { setDir(1); setSelectedMat(k); setStep('detail') }

  const headerTitle =
    step === 'tier'      ? 'Material Catalog' :
    step === 'materials' ? `${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : ''} — Select Material` :
                           (selectedMat ? CATALOG[selectedMat].label : '')

  const headerSub =
    step === 'tier'      ? 'Choose a tier to explore materials' :
    step === 'materials' ? 'Tap any material to see details' :
                           'Specs and options for this material'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: 48, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 48, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className="bg-white w-full max-w-xl max-h-[90vh] rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E8E1D8] flex-shrink-0">
          <div className="flex items-center gap-1">
            {step !== 'tier' && (
              <button
                onClick={goBack}
                className="p-1.5 -ml-1 mr-1 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <div>
              <h2 className="text-base font-bold text-[#1C1C1C]">{headerTitle}</h2>
              <p className="text-xs text-[#8A8178] mt-0.5">{headerSub}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Step content */}
        <AnimatePresence mode="wait">

          {/* ── Step 1: Tier selection ── */}
          {step === 'tier' && (
            <motion.div
              key="tier"
              initial={{ opacity: 0, x: dir * -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -24 }}
              transition={{ duration: 0.15 }}
              className="flex-1 p-6 flex flex-col gap-3"
            >
              {(['economy', 'standard', 'premium'] as Tier[]).map(t => {
                const s = TIER_STYLES[t]
                const cfg = TIER_CONFIG[t]
                return (
                  <button
                    key={t}
                    onClick={() => selectTier(t)}
                    className={`w-full flex items-center gap-4 px-5 py-4 rounded-xl border-2 ${s.border} bg-white hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-150 text-left`}
                  >
                    <span className={`text-2xl font-bold text-[#e07b39] w-12 flex-shrink-0`}>{cfg.symbol}</span>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-[#1C1C1C]">{cfg.label}</p>
                      <p className="text-xs text-[#8A8178] mt-0.5">{cfg.sub}</p>
                    </div>
                    <ChevronLeft size={16} className="text-[#B5AFA7] rotate-180 flex-shrink-0" />
                  </button>
                )
              })}
              <p className="text-center text-[11px] text-[#8A8178] mt-2">
                Indicative market rates · Actual costs vary by location and contractor
              </p>
            </motion.div>
          )}

          {/* ── Step 2: Material grid ── */}
          {step === 'materials' && tier && (
            <motion.div
              key="materials"
              initial={{ opacity: 0, x: dir * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -24 }}
              transition={{ duration: 0.15 }}
              className="overflow-y-auto flex-1 p-4 grid grid-cols-2 gap-3"
            >
              {Object.entries(CATALOG).map(([key, mat]) => (
                <button
                  key={key}
                  onClick={() => selectMat(key)}
                  className="bg-white rounded-xl overflow-hidden border border-[#E8E1D8] shadow-sm hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-150 text-left"
                >
                  <div className="h-24 overflow-hidden relative">
                    {mat.images?.[tier] ? (
                      <img
                        src={mat.images[tier]}
                        alt={mat.label}
                        className="w-full h-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <div className={`w-full h-full bg-gradient-to-br ${mat.bg}`} />
                    )}
                    {/* Label overlay */}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-2 flex items-end justify-between">
                      <p className="text-xs font-semibold text-white leading-tight">{mat.label}</p>
                      <ChevronLeft size={12} className="text-white/70 rotate-180 flex-shrink-0" />
                    </div>
                  </div>
                </button>
              ))}
            </motion.div>
          )}

          {/* ── Step 3: Material detail ── */}
          {step === 'detail' && tier && selectedMat && (() => {
            const mat = CATALOG[selectedMat]
            const td  = mat.tiers[tier]
            const isPaint   = selectedMat === 'paint'
            const isTexture = selectedMat === 'texture_finish'
            return (
              <motion.div
                key="detail"
                initial={{ opacity: 0, x: dir * 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: dir * -24 }}
                transition={{ duration: 0.15 }}
                className="overflow-y-auto flex-1"
              >
                {/* Image banner */}
                <div className="h-36 overflow-hidden">
                  {mat.images?.[tier] ? (
                    <img src={mat.images[tier]} alt={mat.label} className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <div className={`w-full h-full bg-gradient-to-br ${mat.bg}`} />
                  )}
                </div>

                <div className="p-5 space-y-5">
                  {/* Price + zones */}
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-base font-bold text-[#1C1C1C]">{mat.label}</p>
                      <p className="text-[11px] text-[#8A8178] mt-0.5">{mat.zones}</p>
                    </div>
                    <p className="text-base font-bold text-[#e07b39] whitespace-nowrap">
                      ₹{td.rate.toLocaleString('en-IN')}
                      <span className="text-[11px] font-normal text-[#8A8178]"> {mat.unit}</span>
                    </p>
                  </div>

                  {/* Specs */}
                  <div className="bg-[#F5F0E8] rounded-xl p-4 border border-[#EDE7DC] space-y-2">
                    <div className="flex items-start gap-2 text-[11px] text-[#5A5450]">
                      <span className="text-[#8A8178] flex-shrink-0">⏱</span>
                      <span><strong>Lifespan:</strong> {td.durability}</span>
                    </div>
                    <div className="flex items-start gap-2 text-[11px] text-[#5A5450]">
                      <span className="text-[#8A8178] flex-shrink-0">🔧</span>
                      <span><strong>Maintenance:</strong> {td.maintenance}</span>
                    </div>
                    <div className="flex items-start gap-2 text-[11px] text-[#5A5450]">
                      <span className="text-[#8A8178] flex-shrink-0">✓</span>
                      <span><strong>Best for:</strong> {td.bestFor}</span>
                    </div>
                  </div>

                  {/* Colors (paint + texture) */}
                  {(isPaint || isTexture) && (
                    <div>
                      <p className="text-[11px] font-semibold text-[#8A8178] uppercase tracking-wider mb-3">
                        Available Colors
                      </p>
                      <div className="grid grid-cols-5 gap-x-3 gap-y-4">
                        {PAINT_COLORS.map(c => (
                          <div key={c.hex} className="flex flex-col items-center gap-1">
                            <div
                              className="w-10 h-10 rounded-xl shadow-sm border border-black/5"
                              style={{ backgroundColor: c.hex }}
                            />
                            <p className="text-[10px] text-[#5A5450] font-medium text-center leading-tight">{c.name}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Patterns (texture only) */}
                  {isTexture && (
                    <div>
                      <p className="text-[11px] font-semibold text-[#8A8178] uppercase tracking-wider mb-3">
                        Available Patterns
                      </p>
                      <div className="flex flex-wrap gap-4">
                        {TEXTURE_PATTERNS.map(p => (
                          <div key={p.id} className="flex flex-col items-center gap-1.5 w-16">
                            <div className="w-16 h-16 rounded-xl overflow-hidden border-2 border-[#E8E1D8] shadow-sm">
                              <img src={`/catalog/texture-${p.id}.jpg`} alt={p.name} className="w-full h-full object-cover" draggable={false} />
                            </div>
                            <p className="text-[10px] text-[#3A3430] font-semibold text-center">{p.name}</p>
                            <p className="text-[10px] text-[#8A8178] text-center leading-tight">{p.desc}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )
          })()}

        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

// ─── ColorSwatchGrid ──────────────────────────────────────────────────────────

function ColorSwatchGrid({
  selected,
  onSelect,
  hasError,
}: {
  selected?: string
  onSelect: (hex: string) => void
  hasError: boolean
}) {
  return (
    <div>
      <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${hasError && !selected ? 'text-red-400' : 'text-[#8A8178]'}`}>
        Color {hasError && !selected && '(required)'}
      </p>
      <div className="flex flex-wrap gap-2">
        {PAINT_COLORS.map(c => (
          <button
            key={c.hex}
            title={c.name}
            onClick={() => onSelect(c.hex)}
            className={`w-7 h-7 rounded-full border-2 transition-all ${
              selected === c.hex
                ? 'border-[#C8711A] ring-2 ring-[#C8711A]/30 scale-110'
                : 'border-white/50 hover:scale-105 hover:border-slate-300'
            }`}
            style={{ backgroundColor: c.hex, boxShadow: '0 1px 4px rgba(0,0,0,0.18)' }}
          />
        ))}
      </div>
      {selected && (
        <p className="text-xs text-[#8A8178] mt-1.5 flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full border border-[#E8E1D8]" style={{ backgroundColor: selected }} />
          {PAINT_COLORS.find(c => c.hex === selected)?.name}
        </p>
      )}
    </div>
  )
}

// ─── PatternGrid ──────────────────────────────────────────────────────────────

function PatternGrid({
  selected,
  onSelect,
  hasError,
}: {
  selected?: string
  onSelect: (id: string) => void
  hasError: boolean
}) {
  return (
    <div>
      <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${hasError && !selected ? 'text-red-400' : 'text-[#8A8178]'}`}>
        Pattern {hasError && !selected && '(required)'}
      </p>
      <div className="flex flex-wrap gap-3">
        {TEXTURE_PATTERNS.map(p => {
          const active = selected === p.id
          return (
            <button
              key={p.id}
              title={p.desc}
              onClick={() => onSelect(p.id)}
              className={`flex flex-col items-center gap-1 focus:outline-none group transition-all`}
            >
              <div
                className={`w-14 h-14 rounded-lg overflow-hidden border-2 transition-all ${
                  active
                    ? 'border-[#C8711A] ring-2 ring-[#C8711A]/30 scale-105 shadow-md'
                    : 'border-[#E8E1D8] hover:border-[#C8711A]/40 hover:scale-105'
                }`}
              >
                <img
                  src={`/catalog/texture-${p.id}.jpg`}
                  alt={p.name}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </div>
              <span className={`text-[10px] font-medium leading-tight ${
                active ? 'text-[#2C2018]' : 'text-[#8A8178] group-hover:text-[#2C2018]'
              }`}>
                {p.name}
              </span>
            </button>
          )
        })}
      </div>
      {selected && (
        <p className="text-xs text-[#8A8178] mt-1.5">
          {TEXTURE_PATTERNS.find(p => p.id === selected)?.desc}
        </p>
      )}
    </div>
  )
}

// ─── ZoneCard ─────────────────────────────────────────────────────────────────

function ZoneCard({
  zone,
  selection,
  onChange,
  showErrors,
  tier,
}: {
  zone: any
  selection: ZoneSel | undefined
  onChange: (sel: ZoneSel) => void
  showErrors: boolean
  tier: Tier | null
}) {
  const { zone_type } = zone
  const autoMat = AUTO_MATERIAL[zone_type]
  const options = ZONE_MATERIAL_OPTIONS[zone_type] || []
  const complete = isZoneComplete(zone_type, selection)
  const hasError = showErrors && !complete
  const matKey = selection?.material_type || autoMat || null
  const cat = matKey ? CATALOG[matKey] : null

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-white rounded-xl border p-4 shadow-sm transition-colors ${
        hasError ? 'border-red-300' : complete ? 'border-green-200' : 'border-[#E8E1D8]'
      }`}
    >
      {/* Zone header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-sm font-semibold text-[#1C1C1C]">{ZONE_LABEL[zone_type] || zone_type}</p>
          <p className="text-xs text-[#8A8178] mt-0.5">
            {zone.measurement_value} {UNIT_LABEL[zone.measurement_unit] || zone.measurement_unit}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {complete && !autoMat && (
            <CheckCircle2 size={16} className="text-green-500" />
          )}
          {tier && cat && (
            <p className="text-xs font-semibold text-[#e07b39]">
              ₹{cat.tiers[tier].rate.toLocaleString('en-IN')}
              <span className="text-[10px] font-normal text-[#8A8178] ml-0.5">{cat.unit}</span>
            </p>
          )}
        </div>
      </div>

      {/* Auto-applied zone */}
      {autoMat ? (
        <div>
          <span className="inline-flex items-center gap-1.5 bg-green-50 text-green-700 text-xs font-medium px-3 py-1.5 rounded-full border border-green-200">
            <CheckCircle2 size={11} />
            {MATERIAL_LABEL[autoMat]}
          </span>
          <p className="text-[11px] text-[#8A8178] mt-1.5">No selection needed for this zone.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Material dropdown */}
          <div>
            <label className="text-[11px] font-semibold text-[#8A8178] uppercase tracking-wide mb-1.5 block">
              Material
            </label>
            <select
              value={selection?.material_type || ''}
              onChange={e => onChange({ material_type: e.target.value })}
              className={`w-full text-sm text-[#1C1C1C] bg-[#F5F0E8] border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#C8711A]/20 focus:border-[#C8711A] transition-colors cursor-pointer ${
                showErrors && !selection?.material_type
                  ? 'border-red-300'
                  : 'border-[#E8E1D8]'
              }`}
            >
              <option value="" disabled>Select material…</option>
              {options.map(m => (
                <option key={m} value={m}>{MATERIAL_LABEL[m]}</option>
              ))}
            </select>
            {showErrors && !selection?.material_type && (
              <p className="text-[11px] text-red-500 mt-1">Please select a material.</p>
            )}
          </div>

          {/* Color swatch — paint and texture_finish */}
          {(selection?.material_type === 'paint' || selection?.material_type === 'texture_finish') && (
            <ColorSwatchGrid
              selected={selection?.color}
              onSelect={hex => onChange({ ...selection!, color: hex })}
              hasError={showErrors}
            />
          )}

          {/* Pattern grid — texture_finish only */}
          {selection?.material_type === 'texture_finish' && (
            <PatternGrid
              selected={selection?.pattern}
              onSelect={id => onChange({ ...selection!, pattern: id })}
              hasError={showErrors && !!selection?.color}
            />
          )}
        </div>
      )}
    </motion.div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TIER_CONFIG: Record<Tier, { label: string; sub: string; symbol: string }> = {
  economy:  { label: 'Economy',  sub: 'Budget-friendly',   symbol: '₹'   },
  standard: { label: 'Standard', sub: 'Most popular',       symbol: '₹₹'  },
  premium:  { label: 'Premium',  sub: 'Best quality',       symbol: '₹₹₹' },
}

export default function MaterialSelectionPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const mountedRef = useRef(true)

  // Retry mode: set when user navigates back from ResultPage with notes
  const retryMode  = (location.state as any)?.retryMode  as boolean | undefined
  const retryNotes = (location.state as any)?.retryNotes as string  | undefined

  const [tier, setTier] = useState<Tier | null>(null)
  const [selections, setSelections] = useState<Record<string, ZoneSel>>({})
  const [showCatalog, setShowCatalog] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const { data: project, isLoading, isError } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/api/projects/${projectId}`).then((r: { data: any }) => r.data),
    refetchInterval: false,
    // Fresh fetch in retry mode so we see current render_count
    staleTime: retryMode ? 0 : 60_000,
  })

  // Seed selections on load:
  //   - Normal: auto-fill AUTO_MATERIAL zones, rest empty
  //   - Retry:  pre-populate from project.zone_materials + restore previous tier
  useEffect(() => {
    if (!project || initialized) return
    const prevMaterials: any[] = project.zone_materials || []

    const init: Record<string, ZoneSel> = {}
    for (const zone of (project.zones || [])) {
      const autoMat = AUTO_MATERIAL[zone.zone_type]
      if (autoMat) {
        init[zone.id] = { material_type: autoMat }
      } else if (retryMode) {
        // Pre-populate from previous render's material selections
        const prev = prevMaterials.find((m: any) => m.zone_id === zone.id)
        if (prev) {
          init[zone.id] = {
            material_type: prev.material_type,
            color:         prev.color   || undefined,
            pattern:       prev.pattern || undefined,
          }
        }
      }
    }
    setSelections(init)

    // Restore previous tier on retry
    if (retryMode && project.tier) {
      setTier(project.tier as Tier)
    }

    setInitialized(true)
  }, [project, initialized, retryMode])

  // Status guard
  // In retry mode: allow 'completed' (render_count < 2 enforced by backend)
  // Normal mode:   redirect 'completed', 'failed', 'rendering' → result
  useEffect(() => {
    if (!project) return
    const { status } = project
    if (['pending', 'detecting'].includes(status)) {
      navigate(`/projects/${projectId}/upload`, { replace: true })
    } else if (status === 'hitl') {
      navigate(`/projects/${projectId}/review`, { replace: true })
    } else if (!retryMode && ['rendering', 'completed', 'failed'].includes(status)) {
      navigate(`/projects/${projectId}/result`, { replace: true })
    } else if (retryMode && status === 'rendering') {
      // Render already kicked off — go watch it
      navigate(`/projects/${projectId}/result`, { replace: true })
    }
  }, [project?.status, navigate, projectId, retryMode])

  const zones: any[] = project?.zones || []
  const allComplete = !!tier && zones.every(z => isZoneComplete(z.zone_type, selections[z.id]))
  const completedCount = zones.filter(z => isZoneComplete(z.zone_type, selections[z.id])).length

  const handleZoneChange = (zoneId: string, sel: ZoneSel) => {
    setShowErrors(true)
    setSelections(prev => ({ ...prev, [zoneId]: sel }))
  }

  const handleSubmit = async () => {
    setShowErrors(true)
    if (!tier) {
      toast.error('Please select a tier (Economy, Standard, or Premium).')
      return
    }
    if (!allComplete) {
      toast.error('Please complete all material selections before continuing.')
      return
    }
    if (submitting) return

    setSubmitting(true)
    try {
      const materials = zones.map(zone => ({
        zone_id: zone.id,
        material_type: selections[zone.id]?.material_type,
        color:   selections[zone.id]?.color   || null,
        pattern: selections[zone.id]?.pattern || null,
      }))

      await api.post(`/api/projects/${projectId}/materials`, {
        tier,
        materials,
        ...(retryNotes ? { retry_notes: retryNotes } : {}),
      })

      if (mountedRef.current) {
        navigate(`/projects/${projectId}/result`)
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      if (detail === 'Insufficient credits') {
        toast.error('You have no credits left. Contact us for more.')
      } else if (detail === 'Service limit reached. Please contact support.') {
        toast.error('Render limit reached. Please contact support.')
      } else {
        toast.error('Could not save materials. Please try again.')
      }
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  // ── Loading / error ──────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-dot-grid flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#B5AFA7]" />
      </div>
    )
  }

  if (isError || !project) {
    return (
      <div className="min-h-screen bg-dot-grid flex flex-col items-center justify-center gap-4">
        <AlertCircle size={40} className="text-red-400" />
        <p className="text-[#5A5450] text-sm">
          Could not load project.{' '}
          <button onClick={() => navigate('/dashboard')} className="text-[#2C2018] underline">
            Go to dashboard
          </button>
        </p>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-dot-grid">

      {/* Header */}
      <header className="bg-[#F8F5F0]/90 backdrop-blur-sm border-b border-[#E8E1D8] sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center gap-4">
          <button
            onClick={() => navigate(`/projects/${projectId}/review`, {
              state: retryMode ? { retryMode: true, retryNotes } : undefined,
            })}
            className="p-2 -ml-2 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors"
            title="Back to zone review"
          >
            <ChevronLeft size={20} />
          </button>

          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-[#2C2018] rounded-lg flex items-center justify-center font-bold text-white text-xs">R</div>
            <span className="font-semibold text-[#2C2018] hidden sm:block">RenovAI</span>
          </div>

          <button
            onClick={() => navigate('/dashboard')}
            className="ml-1 text-xs text-[#8A8178] hover:text-[#2C2018] hover:underline transition-colors hidden sm:block"
          >
            Dashboard
          </button>

          {/* Breadcrumb */}
          <div className="hidden md:flex items-center gap-2 text-xs text-[#8A8178] ml-2">
            <span className="text-[#B5AFA7]">Upload</span>
            <span className="text-[#B5AFA7]">›</span>
            <span className="text-[#B5AFA7]">Zone Review</span>
            <span className="text-[#B5AFA7]">›</span>
            <span className="font-semibold text-[#2C2018] bg-[#2C2018]/5 px-2 py-0.5 rounded-full">Materials</span>
            <span className="text-[#B5AFA7]">›</span>
            <span className="text-[#B5AFA7]">Result</span>
          </div>

          {/* Credits (right side) */}
          {user && (
            <div className="ml-auto relative group cursor-default">
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                <Zap size={13} className="text-amber-500" />
                <span className="text-xs font-semibold text-amber-700">{user.credits} credit{user.credits !== 1 ? 's' : ''}</span>
              </div>
              <div className="absolute top-full right-0 mt-2 hidden group-hover:block z-50">
                <div className="bg-white border border-[#E8E1D8] text-[#8A8178] text-xs rounded-lg px-3 py-2 whitespace-nowrap shadow-md">
                  <div className="absolute -top-[7px] right-4 border-4 border-transparent border-b-[#E8E1D8]" />
                  <div className="absolute -top-[6px] right-4 border-4 border-transparent border-b-white" />
                  Each render uses 1 credit.
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 page-enter">

        {/* Retry mode banner */}
        {retryMode && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6 flex items-start gap-3"
          >
            <span className="text-amber-500 mt-0.5 flex-shrink-0">⚠</span>
            <div>
              <p className="text-sm font-semibold text-amber-800">Retry Mode</p>
              {retryNotes && (
                <p className="text-xs text-amber-700 mt-0.5">
                  Your notes: <em>"{retryNotes}"</em>
                </p>
              )}
              <p className="text-xs text-amber-600 mt-1">
                Previous selections have been loaded. Update what you'd like to change, then confirm.
              </p>
            </div>
          </motion.div>
        )}

        {/* Page heading */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 mb-8"
        >
          <div>
            <h1 className="text-2xl font-bold text-[#1C1C1C]" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
              {retryMode ? 'Update and Retry' : 'Choose Materials'}
            </h1>
            <p className="text-[#8A8178] mt-1 text-sm">
              {retryMode
                ? 'Adjust your selections and confirm to re-render.'
                : 'Select a tier and pick materials for each zone.'}
            </p>
          </div>
          <button
            onClick={() => setShowCatalog(true)}
            className="flex-shrink-0 flex items-center gap-1.5 text-sm font-medium text-[#2C2018] border border-[#C8711A]/30 px-3 py-2 rounded-lg hover:bg-[#2C2018]/5 transition-colors"
          >
            <BookOpen size={14} />
            View Catalog
          </button>
        </motion.div>

        {/* ── Tier selection ── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mb-8"
        >
          <h2 className="text-xs font-semibold text-[#8A8178] uppercase tracking-wider mb-3">
            Step 1: Select tier
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(['economy', 'standard', 'premium'] as Tier[]).map(t => {
              const cfg = TIER_CONFIG[t]
              const active = tier === t
              return (
                <motion.button
                  key={t}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setTier(t)}
                  className={`rounded-xl border-2 px-4 py-4 text-left transition-all ${
                    active
                      ? 'border-[#C8711A] bg-[#2C2018] shadow-md'
                      : 'border-[#E8E1D8] bg-white hover:border-slate-300 hover:shadow-sm'
                  }`}
                >
                  <p className={`text-xl font-bold mb-1 ${active ? 'text-amber-300' : 'text-[#e07b39]'}`}>
                    {cfg.symbol}
                  </p>
                  <p className={`text-sm font-semibold ${active ? 'text-white' : 'text-[#1C1C1C]'}`}>
                    {cfg.label}
                  </p>
                  <p className={`text-xs mt-0.5 ${active ? 'text-white/65' : 'text-[#8A8178]'}`}>
                    {cfg.sub}
                  </p>
                </motion.button>
              )
            })}
          </div>

          {showErrors && !tier && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-sm text-red-500 mt-2 flex items-center gap-1.5"
            >
              <AlertCircle size={13} />
              Please select a tier to continue.
            </motion.p>
          )}
        </motion.section>

        {/* ── Zone material selection ── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <h2 className="text-xs font-semibold text-[#8A8178] uppercase tracking-wider mb-3 flex items-center gap-2">
            Step 2: Material per zone
            {zones.length > 0 && (
              <span className={`normal-case tracking-normal font-medium text-[11px] px-2 py-0.5 rounded-full ${
                completedCount === zones.length
                  ? 'bg-green-100 text-green-700'
                  : 'bg-[#EDE7DC] text-[#8A8178]'
              }`}>
                {completedCount}/{zones.length} complete
              </span>
            )}
          </h2>

          {zones.length === 0 ? (
            <div className="bg-white rounded-xl border border-[#E8E1D8] p-8 text-center text-[#8A8178] text-sm">
              No zones found. Go back and add zones first.
            </div>
          ) : (
            <div className="space-y-3">
              <AnimatePresence>
                {zones.map(zone => (
                  <ZoneCard
                    key={zone.id}
                    zone={zone}
                    selection={selections[zone.id]}
                    onChange={sel => handleZoneChange(zone.id, sel)}
                    showErrors={showErrors}
                    tier={tier}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </motion.section>

        {/* Credit notice */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-start gap-2">
          <Zap size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-amber-700">
            <strong>1 credit</strong> will be used to generate your renovation render.
            {user && (
              <span className="text-amber-600"> You currently have {user.credits} credit{user.credits !== 1 ? 's' : ''}.</span>
            )}
          </p>
        </div>


        <p className="text-xs text-[#8A8178] mb-4">Area estimation is approximate.</p>

        {/* Confirm button */}
        <button
          onClick={handleSubmit}
          disabled={submitting || !allComplete}
          className="w-full flex items-center justify-center gap-2 bg-[#2C2018] hover:bg-[#3d2a1a] text-white py-3.5 rounded-xl font-medium text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {retryMode ? 'Submitting retry…' : 'Starting render…'}
            </>
          ) : (
            <>
              <CheckCircle2 size={16} />
              {retryMode ? 'Confirm & Retry Render' : 'Confirm & Generate Render'}
            </>
          )}
        </button>
      </main>

      {/* Catalog popup */}
      <AnimatePresence>
        {showCatalog && (
          <CatalogPopup
            defaultTier={tier}
            onClose={() => setShowCatalog(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
