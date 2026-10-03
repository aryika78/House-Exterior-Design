/**
 * ResultPage — Step 5+7: Render polling + before/after comparison + cost breakdown
 *
 * States:
 *   rendering  → full-screen dark overlay with animated progress messages (polls every 3s)
 *   failed     → error card with optional retry button
 *   completed  → render image + compare toggle + cost summary + breakdown popup
 *
 * Cost breakdown popup:
 *   - Inline-editable: measurement, material_rate, labor_rate
 *   - Auto-recalculate dependent fields on edit (client-side)
 *   - Debounced PATCH /cost-items to persist edits
 *
 * Retry flow:
 *   - Only if render_count < 2 (max 2 renders per project)
 *   - User writes notes (required), then navigates back to /materials
 *   - Notes stored in navigate() state, read by MaterialSelectionPage
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import {
  ChevronLeft, ArrowLeftRight, Download, X,
  AlertCircle, Loader2, Zap, LayoutList, CheckCircle2,
  RotateCcw, RefreshCw, Lock, Plus,
} from 'lucide-react'
import api from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'

// ─── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

const WASTAGE: Record<string, number> = {
  paint: 0.10, stone_cladding: 0.15, texture_finish: 0.10, tiles: 0.10,
  glass_railing: 0.05, metal_railing: 0.05, acp_panels: 0.10, metal_gate: 0.00,
}

const TILE_SQFT_BY_TIER: Record<string, number> = {
  economy: 3.9, standard: 3.9, premium: 7.75,
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

const UNIT_LABEL: Record<string, string> = {
  sqft:      'sq ft',
  linear_ft: 'lft',
  count:     'units',
}

const TIER_LABEL: Record<string, string> = {
  economy: 'Economy', standard: 'Standard', premium: 'Premium',
}

const RENDER_MESSAGES = [
  'Analyzing your house structure…',
  'Mapping selected materials to each zone…',
  'Rendering the facade details…',
  'Fine-tuning textures and lighting…',
  'Almost there. Polishing the final image...',
]

// ─── Types ──────────────────────────────────────────────────────────────────────

interface LocalCostItem {
  zone_id: string
  zone_type: string
  material_type: string
  measurement: number
  measurement_unit: string
  material_rate: number
  material_cost: number
  labor_rate: number
  labor_cost: number
  zone_total: number
  liters_needed: number | null
  num_tiles: number | null
  color: string | null
  pattern: string | null
}

// ─── Pure helpers ───────────────────────────────────────────────────────────────

function getImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('http')) return normalized
  return `${BASE_URL}/${normalized}`
}

function recalcItem(item: LocalCostItem, tier: string): LocalCostItem {
  const wastage = WASTAGE[item.material_type] ?? 0
  const effective = item.measurement * (1 + wastage)
  const material_cost = Math.round(effective * item.material_rate * 100) / 100
  const labor_cost    = Math.round(item.measurement * item.labor_rate * 100) / 100  // net, no wastage
  const zone_total    = Math.round((material_cost + labor_cost) * 100) / 100

  let liters_needed: number | null = null
  let num_tiles: number | null = null
  if (item.material_type === 'paint') {
    liters_needed = Math.round(effective / 100 * 100) / 100
  }
  if (item.material_type === 'tiles') {
    const tileSize = TILE_SQFT_BY_TIER[tier] ?? 3.9
    num_tiles = Math.ceil(effective / tileSize)
  }
  return { ...item, material_cost, labor_cost, zone_total, liters_needed, num_tiles }
}

function calcGrandTotal(items: LocalCostItem[]): number {
  return Math.round(items.reduce((s, i) => s + i.zone_total, 0) * 100) / 100
}

function fmtINR(n: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n)
}

// ─── RenderingOverlay ────────────────────────────────────────────────────────────

function RenderingOverlay({ tooLong = false }: { tooLong?: boolean }) {
  const [msgIdx, setMsgIdx] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setMsgIdx(i => (i + 1) % RENDER_MESSAGES.length), 5000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="min-h-screen bg-[#F8F5F0] flex flex-col items-center justify-center gap-10 px-6">
      {/* Animated icon */}
      <div className="relative">
        <div className="w-24 h-24 rounded-3xl bg-white border border-[#E8E1D8] shadow-md flex items-center justify-center">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#C8711A" strokeWidth="1.4">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <div className="absolute -inset-4 rounded-full border-2 border-[#C8711A]/20 animate-ping" style={{ animationDuration: '2s' }} />
        <div className="absolute -inset-8 rounded-full border border-[#C8711A]/10 animate-ping" style={{ animationDuration: '3s', animationDelay: '0.5s' }} />
      </div>

      <div className="text-center space-y-3 max-w-sm">
        <h2 className="text-2xl font-bold text-[#2C2018]">Generating your renovation</h2>
        <AnimatePresence mode="wait">
          <motion.p
            key={msgIdx}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            className="text-[#8A8178] text-sm leading-relaxed"
          >
            {RENDER_MESSAGES[msgIdx]}
          </motion.p>
        </AnimatePresence>
        <p className="text-[#B5AFA7] text-xs">This usually takes 20–45 seconds</p>
      </div>

      {/* Progress dots */}
      <div className="flex gap-2">
        {RENDER_MESSAGES.map((_, i) => (
          <motion.div
            key={i}
            className="w-1.5 h-1.5 rounded-full"
            animate={{ backgroundColor: i === msgIdx ? '#C8711A' : 'rgba(200,113,26,0.2)' }}
            transition={{ duration: 0.4 }}
          />
        ))}
      </div>

      {/* Timeout warning — shown after 5 minutes with no result */}
      <AnimatePresence>
        {tooLong && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-sm w-full bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 text-center"
          >
            <p className="text-amber-700 text-xs font-semibold mb-1">Taking longer than expected</p>
            <p className="text-amber-600 text-[11px] leading-relaxed">
              The AI render is still running. Try refreshing the page — if it's still stuck, go back to your dashboard and check this project in a few minutes.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 text-[11px] font-semibold text-amber-600 hover:text-amber-800 underline transition-colors"
            >
              Refresh now
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── EditableCell ─────────────────────────────────────────────────────────────────

function EditableCell({
  value, prefix, suffix, isCount, onChange,
}: {
  value: number
  prefix?: string
  suffix?: string
  isCount?: boolean
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const isFocused = useRef(false)

  // Sync from parent ONLY when not focused — prevents interrupting the user while typing
  useEffect(() => {
    if (!isFocused.current) setDraft(String(value))
  }, [value])

  function handleChange(raw: string) {
    setDraft(raw)
    // Fire live so calculated columns update on every valid keystroke
    const n = parseFloat(raw)
    if (isNaN(n) || n <= 0) return
    if (isCount && !Number.isInteger(n)) return
    onChange(n)
  }

  function commit(raw: string) {
    const n = parseFloat(raw)
    if (isNaN(n) || n <= 0) { setDraft(String(value)); return }
    if (isCount && !Number.isInteger(n)) { setDraft(String(value)); return }
    onChange(n)
  }

  return (
    <div className="flex items-center justify-end gap-1 min-w-0">
      {prefix && <span className="text-xs text-[#8A8178] flex-shrink-0">{prefix}</span>}
      <input
        type="number"
        min={isCount ? 1 : 0.01}
        step={isCount ? 1 : 'any'}
        value={draft}
        onChange={e => handleChange(e.target.value)}
        onFocus={() => { isFocused.current = true }}
        onBlur={e => { isFocused.current = false; commit(e.target.value) }}
        onKeyDown={e => e.key === 'Enter' && commit(draft)}
        className="w-20 text-right text-xs bg-[#FFF4EA] border border-blue-200 text-[#3A3430] rounded-md px-2 py-1
                   focus:outline-none focus:ring-2 focus:ring-[#C8711A]/20 focus:border-[#C8711A] focus:bg-white
                   hover:bg-blue-100 transition-colors"
        title="Click to edit"
      />
      {suffix && <span className="text-xs text-[#8A8178] flex-shrink-0 whitespace-nowrap">{suffix}</span>}
    </div>
  )
}

// ─── CostBreakdownPopup ────────────────────────────────────────────────────────────

function CostBreakdownPopup({
  items, onClose, onItemChange,
}: {
  items: LocalCostItem[]
  onClose: () => void
  onItemChange: (zoneId: string, field: 'measurement' | 'material_rate' | 'labor_rate', value: number) => void
}) {
  const total = calcGrandTotal(items)
  const totalMat   = items.reduce((s, i) => s + i.material_cost, 0)
  const totalLabor = items.reduce((s, i) => s + i.labor_cost,    0)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
        className="bg-white w-full max-w-5xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E1D8] flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-[#1C1C1C] flex items-center gap-2">
              <LayoutList size={16} className="text-[#2C2018]" />
              Cost Breakdown
            </h2>
            <p className="text-xs text-[#8A8178] mt-0.5">
              Edit quantities or rates to match your contractor quotes. Totals update instantly.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <p className="text-xs text-[#8A8178]">Grand Total</p>
              <p className="text-xl font-bold text-[#2C2018]">{fmtINR(total)}</p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Mobile total */}
        <div className="sm:hidden px-6 py-3 bg-[#2C2018]/5 border-b border-[#EDE7DC]">
          <p className="text-xs text-[#8A8178]">Grand Total: <span className="text-base font-bold text-[#2C2018]">{fmtINR(total)}</span></p>
        </div>

        {/* Scrollable table — Mat Cost + Labor Cost hidden on mobile to reduce horizontal scroll */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm" style={{ minWidth: 520 }}>
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#F5F0E8] border-b border-[#E8E1D8]">
                <th className="text-left px-4 py-3 text-xs font-semibold text-[#8A8178] uppercase tracking-wider w-32">Zone</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-[#8A8178] uppercase tracking-wider w-28">Material</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-blue-500 uppercase tracking-wider">
                  Qty <span className="text-blue-400 font-normal normal-case hidden sm:inline">(editable)</span>
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-blue-500 uppercase tracking-wider">
                  Mat Rate
                </th>
                <th className="hidden sm:table-cell text-right px-4 py-3 text-xs font-semibold text-[#8A8178] uppercase tracking-wider">Mat Cost</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-blue-500 uppercase tracking-wider">
                  Labor Rate
                </th>
                <th className="hidden sm:table-cell text-right px-4 py-3 text-xs font-semibold text-[#8A8178] uppercase tracking-wider">Labor Cost</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-[#8A8178] uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map(item => (
                <tr key={item.zone_type} className="hover:bg-[#F5F0E8]/60 transition-colors">
                  <td className="px-4 py-3.5 align-top">
                    <p className="font-medium text-[#1C1C1C] text-xs leading-tight">
                      {ZONE_LABEL[item.zone_type] || item.zone_type}
                    </p>
                    {item.color && (
                      <span className="inline-flex items-center gap-1 mt-1">
                        <span
                          className="w-3 h-3 rounded-full border border-[#E8E1D8] flex-shrink-0"
                          style={{ background: item.color }}
                        />
                        <span className="text-[10px] text-[#8A8178] hidden sm:inline">{item.color}</span>
                      </span>
                    )}
                    {item.pattern && (
                      <p className="text-[10px] text-[#8A8178] capitalize mt-0.5">{item.pattern}</p>
                    )}
                  </td>
                  <td className="px-4 py-3.5 align-top">
                    <p className="text-[#5A5450] text-xs">
                      {MATERIAL_LABEL[item.material_type] || item.material_type}
                    </p>
                    {item.liters_needed != null && (
                      <p className="text-[10px] text-[#8A8178] mt-0.5">{item.liters_needed} L</p>
                    )}
                    {item.num_tiles != null && (
                      <p className="text-[10px] text-[#8A8178] mt-0.5">{item.num_tiles} tiles</p>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-right align-top">
                    <EditableCell
                      value={item.measurement}
                      suffix={UNIT_LABEL[item.measurement_unit]}
                      isCount={item.measurement_unit === 'count'}
                      onChange={v => onItemChange(item.zone_id, 'measurement', v)}
                    />
                  </td>
                  <td className="px-4 py-3.5 text-right align-top">
                    <EditableCell
                      value={item.material_rate}
                      prefix="₹"
                      suffix={`/${UNIT_LABEL[item.measurement_unit]}`}
                      onChange={v => onItemChange(item.zone_id, 'material_rate', v)}
                    />
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3.5 text-right align-top font-medium text-[#3A3430] text-xs whitespace-nowrap">
                    {fmtINR(item.material_cost)}
                  </td>
                  <td className="px-4 py-3.5 text-right align-top">
                    <EditableCell
                      value={item.labor_rate}
                      prefix="₹"
                      suffix={`/${UNIT_LABEL[item.measurement_unit]}`}
                      onChange={v => onItemChange(item.zone_id, 'labor_rate', v)}
                    />
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3.5 text-right align-top font-medium text-[#3A3430] text-xs whitespace-nowrap">
                    {fmtINR(item.labor_cost)}
                  </td>
                  <td className="px-4 py-3.5 text-right align-top font-semibold text-[#1C1C1C] text-xs whitespace-nowrap">
                    {fmtINR(item.zone_total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-[#F5F0E8]">
                <td colSpan={4} className="px-4 py-4 text-sm font-bold text-[#3A3430]">Grand Total</td>
                <td className="hidden sm:table-cell px-4 py-4 text-right text-sm font-semibold text-[#5A5450]">{fmtINR(totalMat)}</td>
                <td />
                <td className="hidden sm:table-cell px-4 py-4 text-right text-sm font-semibold text-[#5A5450]">{fmtINR(totalLabor)}</td>
                <td className="px-4 py-4 text-right text-base font-bold text-[#2C2018]">{fmtINR(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-[#EDE7DC] flex items-center justify-between gap-4 flex-shrink-0 bg-white">
          <p className="text-[11px] text-[#8A8178] leading-relaxed max-w-lg">
            Blue fields are editable. Changes auto-saved and reflected in the report.
          </p>
          <button
            onClick={onClose}
            className="flex-shrink-0 text-sm font-semibold text-[#2C2018] hover:underline"
          >
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── RetryModal ───────────────────────────────────────────────────────────────────

function RetryModal({
  retriesLeft,
  loadingAction,
  onClose,
  onRerender,
  onChangeMaterials,
}: {
  retriesLeft: number
  loadingAction: 'rerender' | 'materials' | null
  onClose: () => void
  onRerender: (notes: string) => void
  onChangeMaterials: (notes: string) => void
}) {
  const [notes, setNotes] = useState('')
  const valid   = notes.trim().length > 0
  const loading = loadingAction !== null

  // ESC to close (only when not mid-action)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [loading, onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose() }}
    >
      <motion.div
        initial={{ y: 48, opacity: 0 }}
        animate={{ y: 0,  opacity: 1 }}
        exit={{ y: 48, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className="bg-white w-full max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
          <div>
            <h2 className="text-base font-bold text-[#1C1C1C] flex items-center gap-2">
              <RefreshCw size={15} className="text-amber-500" />
              Not happy with the render?
            </h2>
            <p className="text-xs text-[#8A8178] mt-1">
              <span className="text-amber-600 font-medium">{retriesLeft} retry remaining</span>
              {' '}· describe what to fix, then choose how to proceed
            </p>
          </div>
          <button
            onClick={() => !loading && onClose()}
            disabled={loading}
            className="p-1.5 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors flex-shrink-0 disabled:opacity-30"
          >
            <X size={16} />
          </button>
        </div>

        {/* Notes textarea */}
        <div className="px-6 pb-5">
          <label className="block text-xs font-semibold text-[#8A8178] uppercase tracking-wider mb-2">
            What needs to change? <span className="text-red-400">*</span>
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. main wall colour too dark, stone texture barely visible, gate looks unchanged, overall too artificial…"
            rows={3}
            autoFocus
            className="w-full text-sm text-[#3A3430] border border-[#E8E1D8] rounded-xl px-4 py-3
                       focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-400
                       resize-none bg-[#F5F0E8] placeholder-slate-300"
          />
        </div>

        <div className="h-px bg-[#EDE7DC]" />

        {/* 2 action buttons */}
        <div className="px-6 py-4 flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => valid && !loading && onRerender(notes.trim())}
            disabled={!valid || loading}
            className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl
                       bg-amber-400 hover:bg-amber-500 active:bg-amber-600 text-white font-semibold text-sm
                       transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loadingAction === 'rerender'
              ? <Loader2 size={15} className="animate-spin" />
              : <RefreshCw size={15} />
            }
            Re-render now
          </button>

          <button
            onClick={() => valid && !loading && onChangeMaterials(notes.trim())}
            disabled={!valid || loading}
            className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl
                       border-2 border-[#C8711A] text-[#2C2018] font-semibold text-sm
                       hover:bg-[#2C2018]/5 active:bg-[#2C2018]/10 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loadingAction === 'materials'
              ? <Loader2 size={15} className="animate-spin" />
              : <LayoutList size={15} />
            }
            Change materials
          </button>
        </div>

        <div className="px-6 pb-4 flex justify-between items-center">
          <p className="text-[10px] text-[#B5AFA7]">Notes guide the render in both paths</p>
          <button
            onClick={() => !loading && onClose()}
            disabled={loading}
            className="text-xs text-[#8A8178] hover:text-[#5A5450] transition-colors disabled:opacity-30"
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────────

export default function ResultPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, refreshUser } = useAuth()
  const mountedRef = useRef(true)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const localItemsRef = useRef<LocalCostItem[]>([])
  const queryClient = useQueryClient()

  const [compareMode,     setCompareMode]     = useState(false)
  const [showBreakdown,   setShowBreakdown]   = useState(false)
  const [localItems,      setLocalItems]      = useState<LocalCostItem[]>([])
  const [itemsReady,      setItemsReady]      = useState(false)
  const [prevRenderCount, setPrevRenderCount] = useState<number | null>(null)
  const [showRetryModal,    setShowRetryModal]    = useState(false)
  const [loadingAction,     setLoadingAction]     = useState<'rerender' | 'materials' | null>(null)
  const [downloading,       setDownloading]       = useState(false)
  const [creating,          setCreating]          = useState(false)
  const [renderingTooLong,  setRenderingTooLong]  = useState(false)
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current)
    }
  }, [])

  // Keep ref in sync so flushSave can read latest items without stale closure
  useEffect(() => { localItemsRef.current = localItems }, [localItems])

  // ── Data fetching (polls every 3s while rendering) ──────────────────────────

  const { data: project, isLoading, isError } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/api/projects/${projectId}`).then((r: any) => r.data),
    refetchInterval: (query: any) => {
      const status = query.state.data?.status
      return status === 'rendering' ? 3000 : false
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  })

  // ── Initialize localItems from DB (once, and again on each new render) ──────

  useEffect(() => {
    const renderCount = project?.render_count ?? 0
    if (project?.cost_line_items?.length && !itemsReady) {
      setLocalItems(project.cost_line_items.map((i: any) => ({ ...i })))
      setItemsReady(true)
      setPrevRenderCount(renderCount)
    }
    // Re-init when a new render completes (render_count changed)
    if (prevRenderCount !== null && renderCount > prevRenderCount) {
      setLocalItems(project.cost_line_items.map((i: any) => ({ ...i })))
      setPrevRenderCount(renderCount)
      setShowRetryModal(false)
      refreshUser()
    }
    // Always close retry modal if project is failed (it was force-closed remotely)
    if (project?.status === 'failed') setShowRetryModal(false)
  }, [project?.cost_line_items, project?.render_count, project?.status, itemsReady, prevRenderCount])

  // ── Status guard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!project) return
    const { status } = project
    if (['pending', 'detecting'].includes(status)) {
      navigate(`/projects/${projectId}/upload`, { replace: true })
    } else if (status === 'hitl') {
      navigate(`/projects/${projectId}/review`, { replace: true })
    } else if (status === 'material_selection') {
      navigate(`/projects/${projectId}/materials`, { replace: true })
    }
    // rendering → stay (overlay shown)
    // completed / failed → stay
  }, [project?.status, navigate, projectId])

  // ── Rendering timeout — if still rendering after 5 min, show escape hatch ────
  useEffect(() => {
    if (project?.status === 'rendering') {
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current)
      renderTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) setRenderingTooLong(true)
      }, 5 * 60 * 1000) // 5 minutes
    } else {
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current)
      setRenderingTooLong(false)
    }
  }, [project?.status])

  // ── New project ───────────────────────────────────────────────────────────────
  const handleNewProject = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await api.post('/api/projects')
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${(res as any).data.id}/upload`)
    } catch {
      toast.error('Could not create project. Try again.')
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  // ── Inline cost edit ─────────────────────────────────────────────────────────

  const handleItemChange = useCallback((
    zoneId: string,
    field: 'measurement' | 'material_rate' | 'labor_rate',
    value: number,
  ) => {
    setLocalItems(prev => {
      const next = prev.map(item => {
        if (item.zone_id !== zoneId) return item
        const updated = { ...item, [field]: value }
        return recalcItem(updated, project?.tier || 'standard')
      })
      return next
    })

    // Debounced PATCH save
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return
      setLocalItems(current => {
        const payload = current.map(i => ({
          zone_id:       i.zone_id,
          measurement:   i.measurement,
          material_rate: i.material_rate,
          labor_rate:    i.labor_rate,
        }))
        api.patch(`/api/projects/${projectId}/cost-items`, { items: payload })
          .catch(() => { /* silent — UI is already correct */ })
        return current
      })
    }, 700)
  }, [project?.tier, projectId])

  // ── PDF download ──────────────────────────────────────────────────────────────

  // Flush any pending debounced save before generating the PDF
  const flushSave = useCallback(async () => {
    if (!saveTimerRef.current) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    const payload = localItemsRef.current.map(i => ({
      zone_id:       i.zone_id,
      measurement:   i.measurement,
      material_rate: i.material_rate,
      labor_rate:    i.labor_rate,
    }))
    await api.patch(`/api/projects/${projectId}/cost-items`, { items: payload }).catch(() => {})
  }, [projectId])

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await flushSave()   // ensure latest edits are in DB before PDF generation
      const res = await api.post(
        `/api/projects/${projectId}/report`,
        {},
        { responseType: 'blob' },
      )
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }))
      const a   = document.createElement('a')
      a.href     = url
      a.download = `renovation_report_${projectId}_${new Date().toISOString().split('T')[0]}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      toast.error('Could not generate report. Try again.')
    } finally {
      if (mountedRef.current) setDownloading(false)
    }
  }

  // ── Retry: re-render now (same materials + notes) ────────────────────────────

  const handleRerender = async (notes: string) => {
    setLoadingAction('rerender')
    try {
      const res = await api.post(
        `/api/projects/${projectId}/rerender`,
        { retry_notes: notes },
      )
      // Update cache → status='rendering' → overlay shows, polling starts
      queryClient.setQueryData(['project', projectId], (res as any).data)
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Could not start re-render. Try again.')
    } finally {
      if (mountedRef.current) setLoadingAction(null)
    }
  }

  // ── Retry: change materials (step 4) ─────────────────────────────────────────

  const handleChangeMaterials = (notes: string) => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    navigate(`/projects/${projectId}/materials`, {
      state: { retryMode: true, retryNotes: notes },
    })
  }

  // ── Loading / error ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-dot-grid flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#B5AFA7]" />
      </div>
    )
  }

  if (isError || !project) {
    return (
      <div className="min-h-screen bg-dot-grid flex flex-col items-center justify-center gap-4 px-6">
        <AlertCircle size={40} className="text-red-400" />
        <p className="text-[#5A5450] text-sm text-center">
          Could not load project.{' '}
          <button onClick={() => navigate('/dashboard')} className="text-[#2C2018] underline">
            Go to dashboard
          </button>
        </p>
      </div>
    )
  }

  // ── Rendering overlay ─────────────────────────────────────────────────────────

  if (project.status === 'rendering') {
    return <RenderingOverlay tooLong={renderingTooLong} />
  }

  // ── Failed ────────────────────────────────────────────────────────────────────

  if (project.status === 'failed') {
    const canRetry = (project.render_count || 0) < 2
    return (
      <div className="min-h-screen bg-[#F8F5F0] flex flex-col items-center justify-center gap-6 px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl border border-red-200 p-8 max-w-md w-full text-center shadow-lg"
        >
          <AlertCircle size={40} className="text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-[#1C1C1C] mb-2">Render failed</h2>
          <p className="text-[#8A8178] text-sm mb-6">
            Something went wrong while generating your renovation image.
            {canRetry
              ? ' You can retry by going back to materials and trying again.'
              : ' You have used all your retries for this project.'}
          </p>
          <div className="flex flex-col gap-3">
            {canRetry && (
              <button
                onClick={() => navigate(`/projects/${projectId}/materials`, { state: { retryMode: true } })}
                className="w-full bg-[#2C2018] text-white text-sm font-semibold py-3 rounded-xl hover:bg-[#3d2a1a] transition-colors"
              >
                Back to Materials. Retry.
              </button>
            )}
            <button
              onClick={() => navigate('/dashboard')}
              className="w-full border border-[#E8E1D8] text-[#5A5450] text-sm font-semibold py-3 rounded-xl hover:bg-[#F5F0E8] transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        </motion.div>
      </div>
    )
  }

  // ── Completed ────────────────────────────────────────────────────────────────

  const renderUrl   = getImageUrl(project.render_image_url)
  const originalUrl = getImageUrl(project.original_image_url)
  const canRetry    = (project.render_count || 0) < 2
  const total       = localItems.length ? calcGrandTotal(localItems) : (project.total_cost || 0)
  const retriesLeft = 2 - (project.render_count || 0)

  return (
    <div className="min-h-screen bg-[#F8F5F0]">

      {/* Popups — rendered above everything else, both with backdrop blur */}
      <AnimatePresence>
        {showBreakdown && localItems.length > 0 && (
          <CostBreakdownPopup
            items={localItems}
            onClose={() => setShowBreakdown(false)}
            onItemChange={handleItemChange}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRetryModal && (
          <RetryModal
            retriesLeft={retriesLeft}
            loadingAction={loadingAction}
            onClose={() => setShowRetryModal(false)}
            onRerender={handleRerender}
            onChangeMaterials={handleChangeMaterials}
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="bg-[#F8F5F0]/95 backdrop-blur-sm border-b border-[#E8E1D8] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="p-2 -ml-2 rounded-lg text-[#8A8178] hover:text-[#2C2018] hover:bg-[#EDE7DC] transition-colors"
            title="Back to dashboard"
          >
            <ChevronLeft size={20} />
          </button>

          <div className="flex items-center gap-2">
            <span className="font-semibold text-[#2C2018] hidden sm:block">RenovAI</span>
            <div className="w-7 h-7 bg-[#2C2018] rounded-lg flex items-center justify-center font-bold text-white text-xs">R</div>
          </div>

          <div className="hidden md:flex items-center gap-2 text-xs text-[#B5AFA7] ml-2">
            <span>Upload</span><span>›</span>
            <span>Zone Review</span><span>›</span>
            <span>Materials</span><span>›</span>
            <span className="font-semibold text-[#2C2018] bg-[#EDE7DC] px-2 py-0.5 rounded-full">Result</span>
          </div>

          {user && (
            <div className="ml-auto relative group cursor-default">
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                <Zap size={13} className="text-amber-500" />
                <span className="text-xs font-semibold text-amber-700">
                  {user.credits} credit{user.credits !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="absolute top-full right-0 mt-2 hidden group-hover:block z-50">
                <div className="bg-white border border-[#E8E1D8] text-[#8A8178] text-xs rounded-lg px-3 py-2 whitespace-nowrap shadow-md">
                  <div className="absolute -top-[7px] right-4 border-4 border-transparent border-b-[#E8E1D8]" />
                  <div className="absolute -top-[6px] right-4 border-4 border-transparent border-b-white" />
                  Each analysis and render uses 1 credit.
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Page body */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6 page-enter">

        {/* Title */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3"
        >
          <CheckCircle2 size={20} className="text-green-500 flex-shrink-0" />
          <h1 className="text-xl font-bold text-[#2C2018]">Your renovation is ready</h1>
          <span className="ml-auto flex-shrink-0 capitalize bg-[#EDE7DC] text-[#8A8178] text-xs font-medium px-3 py-1 rounded-full">
            {TIER_LABEL[project.tier] || project.tier} tier
          </span>
        </motion.div>

        {/* ── Image area ────────────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="bg-white border border-[#E8E1D8] rounded-2xl overflow-hidden shadow-sm"
        >
          <AnimatePresence mode="wait" initial={false}>
            {compareMode ? (
              /* Side-by-side view */
              <motion.div
                key="compare"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="grid grid-cols-2 gap-0.5 bg-black/20"
              >
                <div className="relative overflow-hidden">
                  <img
                    src={originalUrl || ''}
                    alt="Original house"
                    className="w-full h-64 sm:h-[460px] object-cover"
                  />
                  <div className="absolute bottom-3 left-3 bg-black/60 text-white text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-sm">
                    Before
                  </div>
                </div>
                <div className="relative overflow-hidden">
                  <img
                    src={renderUrl || ''}
                    alt="Renovation render"
                    className="w-full h-64 sm:h-[460px] object-cover"
                  />
                  <div className="absolute bottom-3 right-3 bg-[#2C2018]/80 text-white text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-sm">
                    Your Design
                  </div>
                </div>
              </motion.div>
            ) : (
              /* Single render view */
              <motion.div
                key="single"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="relative"
              >
                <img
                  src={renderUrl || ''}
                  alt="Renovation render"
                  className="w-full h-64 sm:h-[460px] object-cover"
                />
                <div className="absolute bottom-3 right-3 bg-[#2C2018]/80 text-white text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-sm">
                  Your Design
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Image toolbar */}
          <div className="px-4 py-3 flex items-center gap-3 border-t border-[#E8E1D8]">
            <button
              onClick={() => setCompareMode(c => !c)}
              className={`flex items-center gap-2 text-xs font-medium px-3 py-2.5 rounded-lg transition-colors ${
                compareMode
                  ? 'bg-[#2C2018] text-white'
                  : 'bg-[#F5F0E8] text-[#8A8178] hover:bg-[#EDE7DC] hover:text-[#2C2018]'
              }`}
            >
              <ArrowLeftRight size={13} />
              {compareMode ? 'Single view' : 'Compare with original'}
            </button>
          </div>
        </motion.div>

        {/* ── Cost summary card ─────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="bg-white rounded-2xl border border-[#E8E1D8] shadow-xl p-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            {/* Total */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-[#8A8178] uppercase tracking-wider mb-1">
                Estimated Total Cost
              </p>
              <p className="text-4xl font-extrabold text-[#2C2018] leading-none">
                {fmtINR(total)}
              </p>
              <p className="text-xs text-[#8A8178] mt-2">
                Includes material + labour costs
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3 sm:flex-nowrap sm:flex-col sm:items-end">
              <button
                onClick={() => setShowBreakdown(true)}
                className="flex items-center gap-2 bg-[#2C2018] text-white text-sm font-semibold
                           px-4 py-3 rounded-xl hover:bg-[#3d2a1a] transition-colors"
              >
                <LayoutList size={15} />
                View Breakdown
              </button>

              <button
                onClick={handleDownload}
                disabled={downloading}
                className="flex items-center gap-2 border-2 border-[#C8711A] text-[#2C2018] text-sm font-semibold
                           px-4 py-3 rounded-xl hover:bg-[#2C2018]/5 transition-colors disabled:opacity-40"
              >
                {downloading
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Download size={15} />
                }
                Download Report
              </button>

              {canRetry ? (
                <button
                  onClick={() => setShowRetryModal(true)}
                  className="flex items-center gap-2 border border-[#E8E1D8] text-[#8A8178] text-sm font-medium
                             px-4 py-3 rounded-xl hover:bg-[#F5F0E8] transition-colors"
                >
                  <RotateCcw size={14} />
                  Not satisfied? Retry
                  <span className="ml-0.5 text-[10px] bg-[#EDE7DC] text-[#8A8178] px-1.5 py-0.5 rounded-full">
                    {retriesLeft} left
                  </span>
                </button>
              ) : (
                <div className="rounded-xl bg-[#F5F0E8] border border-[#EDE7DC] overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Lock size={13} className="text-[#B5AFA7] flex-shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-[#8A8178]">Max renders reached</p>
                      <p className="text-[10px] text-[#B5AFA7] mt-0.5">
                        Download your report · or try different materials in a new project
                      </p>
                    </div>
                  </div>
                  <div className="border-t border-[#EDE7DC] px-4 py-2.5">
                    <button
                      onClick={handleNewProject}
                      disabled={creating}
                      className="flex items-center gap-2 text-xs font-semibold text-[#2C2018] hover:text-[#3d2a1a] transition-colors disabled:opacity-40"
                    >
                      {creating
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Plus size={12} />
                      }
                      {creating ? 'Creating…' : 'Start new project'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── Disclaimers ──────────────────────────────────────────────────────── */}
        <div className="bg-[#F5F0E8] border border-[#E8E1D8] rounded-xl px-5 py-4 space-y-1.5">
          <p className="text-[11px] text-[#B5AFA7] leading-relaxed">
            • Rates are indicative market averages. Actual costs vary by location, contractor, and market conditions.
          </p>
          <p className="text-[11px] text-[#B5AFA7] leading-relaxed">
            • This report is for planning purposes only and is not a legally binding quotation.
          </p>
        </div>

      </main>
    </div>
  )
}
