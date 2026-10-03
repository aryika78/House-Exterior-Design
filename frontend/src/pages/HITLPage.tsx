/**
 * HITLPage — Human-in-the-loop zone review (Step 3)
 *
 * User reviews AI-detected zones, edits measurements, adds / removes zones.
 * POST /api/projects/:id/zones → advances status to material_selection.
 *
 * Race-condition guards:
 * - mountedRef prevents setState after unmount
 * - Status guard redirects away if project is already past/before this step
 * - Submit button disabled while in-flight; no double submit
 */
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import {
  ChevronLeft, Plus, Trash2, AlertCircle,
  Loader2, Info, CheckCircle2,
} from 'lucide-react'
import api from '@/services/api'

// ─── Zone metadata ─────────────────────────────────────────────────────────────

const ZONE_META: Record<string, {
  label: string
  unit: string
  unitLabel: string
  isCount: boolean
}> = {
  main_walls:         { label: 'Main Walls',            unit: 'sqft',      unitLabel: 'sq ft',     isCount: false },
  columns_pillars:    { label: 'Columns & Pillars',     unit: 'sqft',      unitLabel: 'sq ft',     isCount: false },
  parapet_wall:       { label: 'Parapet Wall',          unit: 'sqft',      unitLabel: 'sq ft',     isCount: false },
  balcony_floor:      { label: 'Balcony Floor',         unit: 'sqft',      unitLabel: 'sq ft',     isCount: false },
  balcony_railing:    { label: 'Balcony Railing',       unit: 'linear_ft', unitLabel: 'linear ft', isCount: false },
  gate_grille:        { label: 'Gate Grille',           unit: 'count',     unitLabel: 'count',     isCount: true  },
  gate_boundary_wall: { label: 'Gate / Boundary Wall',  unit: 'sqft',      unitLabel: 'sq ft',     isCount: false },
  roof_edge_railing:  { label: 'Roof Edge Railing',     unit: 'linear_ft', unitLabel: 'linear ft', isCount: false },
}

const ALL_ZONE_TYPES = Object.keys(ZONE_META)
const IMAGE_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface LocalZone {
  tempId: string
  zone_type: string
  measurement_value: string   // string while editing, converted on submit
  ai_detected: boolean
}

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

// ─── Validation helper ─────────────────────────────────────────────────────────

function getValueError(zone: LocalZone): string | null {
  const v = zone.measurement_value.trim()
  if (!v) return 'Required'
  const num = Number(v)
  if (isNaN(num)) return 'Must be a number'
  if (num <= 0) return 'Must be > 0'
  if (ZONE_META[zone.zone_type]?.isCount && !Number.isInteger(num)) return 'Whole number only'
  return null
}

// ─── ZoneRow ───────────────────────────────────────────────────────────────────

function ZoneRow({
  zone,
  allZones,
  onChange,
  onDelete,
  showErrors,
}: {
  zone: LocalZone
  allZones: LocalZone[]
  onChange: (updated: LocalZone) => void
  onDelete: () => void
  showErrors: boolean
}) {
  const meta = ZONE_META[zone.zone_type]
  const valueError = showErrors ? getValueError(zone) : null

  // This row's dropdown: own type + types not taken by other rows
  const availableTypes = ALL_ZONE_TYPES.filter(
    t => t === zone.zone_type || !allZones.some(z => z.zone_type === t && z.tempId !== zone.tempId)
  )

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, transition: { duration: 0.18 } }}
      className="bg-white rounded-xl border border-[#E8E1D8] p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">

        {/* Zone type selector */}
        <div className="flex-1 min-w-0">
          <label className="text-[11px] font-semibold text-[#8A8178] uppercase tracking-wide mb-1.5 block">
            Zone
          </label>
          <select
            value={zone.zone_type}
            onChange={e => {
              onChange({
                ...zone,
                zone_type: e.target.value,
                measurement_value: '',   // reset value when type changes
              })
            }}
            className="w-full text-sm text-[#1C1C1C] bg-[#F5F0E8] border border-[#E8E1D8] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#C8711A]/20 focus:border-[#C8711A] transition-colors cursor-pointer"
          >
            {availableTypes.map(t => (
              <option key={t} value={t}>{ZONE_META[t].label}</option>
            ))}
          </select>
        </div>

        {/* Measurement value + unit */}
        <div className="w-28 sm:w-40 flex-shrink-0">
          <label className="text-[11px] font-semibold text-[#8A8178] uppercase tracking-wide mb-1.5 block">
            {meta?.isCount ? 'Count' : 'Measurement'}
          </label>
          <div className={`flex items-stretch border rounded-lg overflow-hidden transition-colors ${
            valueError
              ? 'border-red-400 focus-within:border-red-400'
              : 'border-[#E8E1D8] focus-within:border-[#C8711A]'
          }`}>
            <input
              type="number"
              min={meta?.isCount ? 1 : 0.1}
              step={meta?.isCount ? 1 : 'any'}
              value={zone.measurement_value}
              onChange={e => onChange({ ...zone, measurement_value: e.target.value })}
              placeholder={meta?.isCount ? '1' : '0.0'}
              className="flex-1 w-0 min-w-0 text-sm text-[#1C1C1C] bg-white px-2.5 py-2 focus:outline-none"
            />
            <span className="text-[11px] text-[#8A8178] bg-[#F5F0E8] px-2 py-2 border-l border-[#E8E1D8] whitespace-nowrap self-stretch flex items-center">
              {meta?.unitLabel}
            </span>
          </div>
          {valueError && (
            <p className="text-[11px] text-red-500 mt-1">{valueError}</p>
          )}
        </div>

        {/* Delete button */}
        <button
          onClick={onDelete}
          className="mt-7 p-2 rounded-lg text-[#B5AFA7] hover:text-red-400 hover:bg-red-50 transition-colors flex-shrink-0"
          title="Remove zone"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </motion.div>
  )
}

// ─── AddZoneRow ────────────────────────────────────────────────────────────────

function AddZoneRow({
  existingTypes,
  onAdd,
}: {
  existingTypes: string[]
  onAdd: (zone_type: string, value: string) => void
}) {
  const available = ALL_ZONE_TYPES.filter(t => !existingTypes.includes(t))
  const [selectedType, setSelectedType] = useState(available[0] || '')
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)

  // If our selectedType got taken by main list, reset to first available
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const avail = ALL_ZONE_TYPES.filter(t => !existingTypes.includes(t))
    if (!avail.includes(selectedType)) {
      setSelectedType(avail[0] || '')
      setValue('')
      setTouched(false)
    }
  }, [existingTypes.join(',')])   // stable string dep

  if (available.length === 0) return null

  const meta = ZONE_META[selectedType]
  const err = touched
    ? getValueError({ tempId: '', zone_type: selectedType, measurement_value: value, ai_detected: false })
    : null
  const canAdd = !!selectedType && !getValueError({
    tempId: '', zone_type: selectedType, measurement_value: value, ai_detected: false,
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[#F5F0E8] rounded-xl border border-dashed border-slate-300 p-4"
    >
      <p className="text-[11px] font-semibold text-[#8A8178] uppercase tracking-wide mb-3 flex items-center gap-1.5">
        <Plus size={11} />
        Add a zone
      </p>

      <div className="flex items-start gap-3">
        {/* Zone type dropdown */}
        <div className="flex-1 min-w-0">
          <label className="text-[11px] text-[#8A8178] mb-1 block">Zone</label>
          <select
            value={selectedType}
            onChange={e => {
              setSelectedType(e.target.value)
              setValue('')
              setTouched(false)
            }}
            className="w-full text-sm text-[#1C1C1C] bg-white border border-[#E8E1D8] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#C8711A]/20 focus:border-[#C8711A] transition-colors cursor-pointer"
          >
            {available.map(t => (
              <option key={t} value={t}>{ZONE_META[t].label}</option>
            ))}
          </select>
        </div>

        {/* Value input */}
        <div className="w-40 flex-shrink-0">
          <label className="text-[11px] text-[#8A8178] mb-1 block">
            {meta?.isCount ? 'Count' : 'Measurement'}
          </label>
          <div className={`flex items-stretch border rounded-lg overflow-hidden transition-colors ${
            err
              ? 'border-red-400'
              : 'border-[#E8E1D8] focus-within:border-[#C8711A]'
          }`}>
            <input
              type="number"
              min={meta?.isCount ? 1 : 0.1}
              step={meta?.isCount ? 1 : 'any'}
              value={value}
              onChange={e => setValue(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={meta?.isCount ? '1' : '0.0'}
              className="flex-1 w-0 min-w-0 text-sm text-[#1C1C1C] bg-white px-2.5 py-2 focus:outline-none"
            />
            <span className="text-[11px] text-[#8A8178] bg-[#F5F0E8] px-2 py-2 border-l border-[#E8E1D8] whitespace-nowrap self-stretch flex items-center">
              {meta?.unitLabel}
            </span>
          </div>
          {err && <p className="text-[11px] text-red-500 mt-1">{err}</p>}
        </div>

        {/* Add button */}
        <button
          disabled={!canAdd}
          onClick={() => {
            if (!canAdd) return
            onAdd(selectedType, value)
            setValue('')
            setTouched(false)
          }}
          className="mt-5 flex items-center gap-1.5 text-sm font-medium px-4 py-2.5 rounded-lg bg-[#2C2018] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#3d2a1a] transition-colors flex-shrink-0"
        >
          <Plus size={14} />
          Add
        </button>
      </div>
    </motion.div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function HITLPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate    = useNavigate()
  const location    = useLocation()
  const queryClient = useQueryClient()
  const mountedRef = useRef(true)

  // Retry mode: passed from ResultPage when user chose "Fix zones first"
  const retryMode  = (location.state as any)?.retryMode  as boolean | undefined
  const retryNotes = (location.state as any)?.retryNotes as string  | undefined

  const [localZones, setLocalZones] = useState<LocalZone[]>([])
  const [zonesInitialized, setZonesInitialized] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  // Captured ONCE at load time from the DB zones — not recomputed from live edits.
  // Prevents the fallback banner from appearing/disappearing as the user edits zones.
  // True only when the project arrived at HITL via the fallback path (all zones pre-filled,
  // none AI-detected), not if the user happens to delete AI zones and add manual ones.
  const [initiallyAllDefaults, setInitiallyAllDefaults] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const { data: project, isLoading, isError } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/api/projects/${projectId}`).then((r: { data: any }) => r.data),
    refetchInterval: false,
    staleTime: 60_000,
  })

  // Initialize local edit state from fetched zones (once only).
  // Also captures whether ALL initial zones were non-AI-detected (fallback path)
  // so we can show the correct heading/banner without it flickering as the user edits.
  useEffect(() => {
    if (project && !zonesInitialized) {
      const zones: LocalZone[] = (project.zones || []).map((z: any) => ({
        tempId: genId(),
        zone_type: z.zone_type,
        measurement_value: z.measurement_value != null ? String(z.measurement_value) : '',
        ai_detected: z.ai_detected ?? true,
      }))
      setLocalZones(zones)
      setZonesInitialized(true)
      // Snapshot at load: is this a fallback-defaults project?
      // Only true when every zone came pre-filled (none were AI-detected).
      // Must be set from the DB data, not from live edits, so the banner
      // doesn't appear/disappear as the user edits or deletes zones.
      setInitiallyAllDefaults(zones.length > 0 && zones.every(z => !z.ai_detected))
    }
  }, [project, zonesInitialized])

  // Status guard — redirect if project is at the wrong step.
  // NOTE: 'material_selection' is intentionally NOT redirected here — the user
  // can freely navigate back from Step 4 (Materials) to Step 3 (Zone Review)
  // to check their zones. The submit button is replaced with a "Back to Materials"
  // button when status is already material_selection.
  useEffect(() => {
    if (!project) return
    if (project.status === 'pending' || project.status === 'detecting') {
      navigate(`/projects/${projectId}/upload`, { replace: true })
    } else if (!retryMode && (project.status === 'rendering' || project.status === 'completed' || project.status === 'failed')) {
      navigate(`/projects/${projectId}/result`, { replace: true })
    }
  }, [project?.status, navigate, projectId])

  // ── Zone handlers ────────────────────────────────────────────────────────────

  const handleChange = (tempId: string, updated: LocalZone) =>
    setLocalZones(prev => prev.map(z => z.tempId === tempId ? updated : z))

  const handleDelete = (tempId: string) =>
    setLocalZones(prev => prev.filter(z => z.tempId !== tempId))

  const handleAdd = (zone_type: string, measurement_value: string) =>
    setLocalZones(prev => [...prev, { tempId: genId(), zone_type, measurement_value, ai_detected: false }])

  // ── Submit ───────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    setShowErrors(true)

    if (localZones.length === 0) {
      toast.error('Add at least one zone to continue.')
      return
    }
    const firstError = localZones.find(z => getValueError(z))
    if (firstError) {
      toast.error('Fix the highlighted errors before continuing.')
      return
    }
    if (submitting) return

    setSubmitting(true)
    try {
      await api.post(`/api/projects/${projectId}/zones`, {
        zones: localZones.map(z => ({
          zone_type: z.zone_type,
          measurement_value: Number(z.measurement_value),
          measurement_unit: ZONE_META[z.zone_type].unit,
          ai_detected: z.ai_detected,
        })),
      })
      if (mountedRef.current) {
        // Optimistically update cache to material_selection so MaterialSelectionPage's
        // status guard doesn't briefly see stale 'hitl' status and redirect back here.
        queryClient.setQueryData(['project', projectId], (old: any) =>
          old ? { ...old, status: 'material_selection' } : old
        )
        navigate(`/projects/${projectId}/materials`, {
          state: retryMode ? { retryMode: true, retryNotes } : undefined,
        })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : 'Could not save zones. Try again.')
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  const allValid = localZones.length > 0 && localZones.every(z => !getValueError(z))

  // ── Loading / error states ───────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-dot-grid flex flex-col items-center justify-center gap-3">
        <div className="relative w-14 h-14">
          <div className="absolute inset-0 rounded-xl bg-[#2C2018]/10 animate-ping" />
          <div className="relative w-14 h-14 bg-[#2C2018] rounded-xl flex items-center justify-center">
            <Loader2 size={22} className="animate-spin text-white" />
          </div>
        </div>
        <p className="text-sm text-[#8A8178]">Loading zones…</p>
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

  const imageUrl = project.original_image_url
    ? (project.original_image_url.startsWith('http')
        ? project.original_image_url
        : `${IMAGE_BASE}/${project.original_image_url}`)
    : null
  const existingTypes = localZones.map(z => z.zone_type)
  const hasFormErrors = showErrors && localZones.some(z => getValueError(z))

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-dot-grid">

      {/* ── Header ── */}
      <header className="bg-[#F8F5F0]/90 backdrop-blur-sm border-b border-[#E8E1D8] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="p-2 -ml-2 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors"
            title="Dashboard"
          >
            <ChevronLeft size={20} />
          </button>

          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-[#2C2018] rounded-lg flex items-center justify-center font-bold text-white text-xs">R</div>
            <span className="font-semibold text-[#2C2018] hidden sm:block">RenovAI</span>
          </div>

          {/* Step breadcrumb */}
          <div className="hidden md:flex items-center gap-2 text-xs text-[#8A8178] ml-2">
            <span className="text-[#B5AFA7]">Upload</span>
            <span className="text-[#B5AFA7]">›</span>
            <span className="font-semibold text-[#2C2018] bg-[#2C2018]/5 px-2 py-0.5 rounded-full">Zone Review</span>
            <span className="text-[#B5AFA7]">›</span>
            <span className="text-[#B5AFA7]">Materials</span>
            <span className="text-[#B5AFA7]">›</span>
            <span className="text-[#B5AFA7]">Result</span>
          </div>
        </div>
      </header>

      {/* ── Two-column layout ── */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 page-enter">
        <div className="lg:grid lg:grid-cols-5 lg:gap-8 flex flex-col gap-6">

          {/* Left: original photo (sticky on desktop) */}
          <div className="lg:col-span-2">
            <div className="lg:sticky lg:top-24">
              <motion.div
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.35 }}
                className="bg-white rounded-2xl overflow-hidden border border-[#E8E1D8] shadow-sm"
              >
                {/* Photo */}
                <div className="relative bg-[#EDE7DC] h-52 sm:h-64 lg:h-[400px]">
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt="Uploaded house exterior"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-[#B5AFA7]">
                      <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 19.5h18M3 4.5h18" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-4 py-3 pointer-events-none">
                    <p className="text-white text-xs font-medium">Your uploaded photo</p>
                  </div>
                </div>

                {/* Hint */}
                <div className="px-4 py-3 border-t border-[#EDE7DC]">
                  <div className="flex items-start gap-2">
                    <Info size={13} className="text-[#8A8178] mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-[#8A8178] leading-relaxed">
                      {initiallyAllDefaults
                        ? 'Use this photo as a reference while entering measurements. Edit the pre-filled values to match what you can see.'
                        : "Refer to this photo while reviewing. Edit any measurement that doesn't look right, or add zones that may have been missed."}
                    </p>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>

          {/* Right: zone editor */}
          <div className="lg:col-span-3">
            <motion.div
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.35 }}
            >
              {/* Section heading */}
              <div className="mb-5">
                <h1 className="text-xl font-bold text-[#1C1C1C]" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
                  {initiallyAllDefaults ? 'Enter Your Measurements' : 'Review Detected Zones'}
                </h1>
                <p className="text-sm text-[#8A8178] mt-1">
                  {initiallyAllDefaults
                    ? "We've pre-filled a typical starting value. Adjust it to match your house and add any other zones that are visible."
                    : localZones.length > 0
                      ? `We found ${localZones.length} zone${localZones.length !== 1 ? 's' : ''}. Edit, add, or remove as needed.`
                      : 'No zones were identified. Add zones manually using the form below.'}
                </p>
              </div>

              {/* Fallback-defaults banner */}
              {initiallyAllDefaults && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-start gap-2"
                >
                  <AlertCircle size={15} className="text-amber-500 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-amber-700 leading-relaxed">
                    We had trouble reading your photo, so we've pre-filled a typical starting value of 400 sq ft for main walls.
                    Please update this to match your actual measurements, and add any other zones visible on your house.
                  </p>
                </motion.div>
              )}

              {/* Empty state warning */}
              {localZones.length === 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-start gap-2"
                >
                  <AlertCircle size={15} className="text-amber-500 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-amber-700">No zones yet. Add at least one zone to proceed.</p>
                </motion.div>
              )}

              {/* Zone list */}
              <div className="space-y-3 mb-4">
                <AnimatePresence mode="popLayout">
                  {localZones.map(zone => (
                    <ZoneRow
                      key={zone.tempId}
                      zone={zone}
                      allZones={localZones}
                      onChange={updated => handleChange(zone.tempId, updated)}
                      onDelete={() => handleDelete(zone.tempId)}
                      showErrors={showErrors}
                    />
                  ))}
                </AnimatePresence>
              </div>

              {/* Add zone row (only when slots remain) */}
              {existingTypes.length < ALL_ZONE_TYPES.length && (
                <div className="mb-6">
                  <AddZoneRow existingTypes={existingTypes} onAdd={handleAdd} />
                </div>
              )}


              <p className="text-xs text-[#8A8178] mb-4">Area estimation is approximate.</p>

              {/* Form error summary */}
              {hasFormErrors && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-sm text-red-500 mb-3 flex items-center gap-1.5"
                >
                  <AlertCircle size={14} />
                  Fix the highlighted errors above before continuing.
                </motion.p>
              )}

              {/* Confirm button — or "Back to Materials" if already confirmed */}
              {project.status === 'material_selection' ? (
                <button
                  onClick={() => navigate(`/projects/${projectId}/materials`, {
                    state: retryMode ? { retryMode: true, retryNotes } : undefined,
                  })}
                  className="w-full flex items-center justify-center gap-2 bg-[#2C2018] hover:bg-[#3d2a1a] text-white py-3.5 rounded-xl font-medium text-sm transition-colors"
                >
                  <CheckCircle2 size={16} />
                  Confirm Zones and Continue
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={submitting || (showErrors && !allValid)}
                  className="w-full flex items-center justify-center gap-2 bg-[#2C2018] hover:bg-[#3d2a1a] text-white py-3.5 rounded-xl font-medium text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Saving zones…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={16} />
                      Confirm Zones &amp; Choose Materials
                    </>
                  )}
                </button>
              )}
            </motion.div>
          </div>

        </div>
      </main>
    </div>
  )
}
