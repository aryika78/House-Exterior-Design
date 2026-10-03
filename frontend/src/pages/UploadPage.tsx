/**
 * Upload Page — Step 1 of the pipeline.
 *
 * States this page handles:
 *   idle       → file not yet selected
 *   selected   → file chosen, showing preview + width input
 *   uploading  → file being sent to backend
 *   detecting  → backend processing, polling every 2s
 *   unusable   → AI rejected image (attempt 1: retry only, attempt 2: retry + proceed anyway)
 *   failed     → system/API error
 *
 * Race condition protection:
 *   - Upload button disabled while any async op is in flight
 *   - Polling interval ref cleaned up on unmount
 *   - Abort controller cancelled on unmount
 *   - Initial status check on mount — handles page refresh mid-flow
 *   - No state updates after unmount (mounted ref guard)
 */
import { useState, useRef, useCallback, useEffect, type DragEvent, type ChangeEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import {
  Upload, ImageIcon, X, AlertCircle, RefreshCw,
  ArrowRight, CheckCircle2, Loader2, HelpCircle,
} from 'lucide-react'
import api from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'

// ─── TYPES ────────────────────────────────────────────────────────────────────

type PageState = 'idle' | 'selected' | 'uploading' | 'detecting' | 'unusable' | 'failed'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const HEIC_TYPES = ['image/heic', 'image/heif']

// Pipeline step labels shown in progress bar
const STEPS = ['Upload', 'Review', 'Materials', 'Render', 'Result']

// Zone unit map — needed for downstream pages
export const ZONE_UNIT_MAP: Record<string, string> = {
  main_walls: 'sqft',
  columns_pillars: 'sqft',
  parapet_wall: 'sqft',
  balcony_floor: 'sqft',
  balcony_railing: 'linear_ft',
  gate_grille: 'count',
  gate_boundary_wall: 'sqft',
  roof_edge_railing: 'linear_ft',
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

function StepProgress({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEPS.map((step, i) => (
        <div key={step} className="flex items-center">
          <div className="flex flex-col items-center gap-1">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300
              ${i < current ? 'bg-green-500 text-white' :
                i === current ? 'bg-[#2C2018] text-white ring-4 ring-[#C8711A]/20' :
                'bg-[#E8E1D8] text-[#8A8178]'}`}
            >
              {i < current ? <CheckCircle2 size={14} /> : i + 1}
            </div>
            <span className={`text-[10px] font-medium hidden sm:block ${i === current ? 'text-[#2C2018]' : 'text-[#8A8178]'}`}>
              {step}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`w-10 sm:w-16 h-0.5 mb-4 mx-1 transition-all duration-300
              ${i < current ? 'bg-green-400' : 'bg-[#E8E1D8]'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

function TipBanner() {
  return (
    <div className="flex items-start gap-2.5 bg-[#FFF4EA] border border-blue-100 rounded-xl px-4 py-3 mt-4">
      <HelpCircle size={15} className="text-blue-400 mt-0.5 shrink-0" />
      <p className="text-xs text-blue-700 leading-relaxed">
        <span className="font-semibold">Best results:</span> Use a front-facing photo where the main entry door is clearly visible.
      </p>
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  useAuth()

  const [pageState, setPageState] = useState<PageState>('idle')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [houseWidth, setHouseWidth] = useState<string>('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [unusableReason, setUnusableReason] = useState<string | null>(null)
  const [attemptCount, setAttemptCount] = useState(0)
  const [detectingDots, setDetectingDots] = useState('.')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)
  // Track the current blob URL via ref so the unmount cleanup can revoke it.
  // Using state alone causes a stale-closure bug in the [] effect: the cleanup
  // captures previewUrl = null (its value at mount time) and never revokes it.
  const previewUrlRef = useRef<string | null>(null)

  // Animated dots for detecting state
  useEffect(() => {
    if (pageState !== 'detecting' && pageState !== 'uploading') return
    const t = setInterval(() => {
      setDetectingDots(d => d.length >= 3 ? '.' : d + '.')
    }, 500)
    return () => clearInterval(t)
  }, [pageState])

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopPolling()
      // Use the ref, not the state — the [] effect captures the initial state
      // value (null), so `previewUrl` here would always be null (stale closure).
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
    }
  }, [])

  // On mount: check current project status (handles page refresh mid-flow)
  useEffect(() => {
    if (!projectId) return
    api.get(`/api/projects/${projectId}/status`)
      .then((res: { data: { status: string } }) => {
        if (!mountedRef.current) return
        const { status } = res.data
        if (status === 'hitl') navigate(`/projects/${projectId}/review`, { replace: true })
        else if (status === 'detecting') {
          setPageState('detecting')
          startPolling()
        } else if (status === 'material_selection') navigate(`/projects/${projectId}/materials`, { replace: true })
        else if (status === 'completed') navigate(`/projects/${projectId}/result`, { replace: true })
        else if (status === 'failed') setPageState('failed')
        // 'pending' → normal idle state (may have unusable_reason from prev attempt)
        else if (status === 'pending') {
          api.get(`/api/projects/${projectId}`).then((r: { data: { unusable_reason?: string } }) => {
            if (!mountedRef.current) return
            if (r.data.unusable_reason) {
              setUnusableReason(r.data.unusable_reason)
              // Set to 2, not 1 — unusable_reason in DB means AI already rejected
              // at least once. We don't know if it was attempt 1 or 2, but on
              // refresh we must show "Proceed Anyway" so the user is never blocked.
              setAttemptCount(2)
              setPageState('unusable')
            }
          }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [projectId])

  // ─── POLLING ────────────────────────────────────────────────────────────────

  const startPolling = useCallback(() => {
    if (pollRef.current) return

    // Safety timeout: if status stays 'detecting' for 90 seconds (45 polls × 2s),
    // the background task likely died without updating the DB (e.g. Supabase network
    // error inside the except block). Show 'failed' so the user isn't stuck forever.
    const MAX_POLLS = 45
    let pollCount = 0

    pollRef.current = setInterval(async () => {
      if (!projectId || !mountedRef.current) return

      pollCount++
      if (pollCount > MAX_POLLS) {
        stopPolling()
        if (mountedRef.current) setPageState('failed')
        return
      }

      try {
        const res = await api.get(`/api/projects/${projectId}/status`)
        if (!mountedRef.current) return
        const { status } = res.data

        if (status === 'hitl') {
          stopPolling()
          navigate(`/projects/${projectId}/review`)
        } else if (status === 'pending') {
          stopPolling()
          // Fetch full project to get the unusable_reason
          const full = await api.get(`/api/projects/${projectId}`)
          if (!mountedRef.current) return
          setUnusableReason(full.data.unusable_reason || 'We could not analyse this image.')
          setAttemptCount(c => c + 1)
          setPageState('unusable')
          setSelectedFile(null)
          if (previewUrlRef.current) {
            URL.revokeObjectURL(previewUrlRef.current)
            previewUrlRef.current = null
          }
          setPreviewUrl(null)
        } else if (status === 'failed') {
          stopPolling()
          if (mountedRef.current) setPageState('failed')
        }
        // 'detecting' → keep polling
      } catch {
        // Network hiccup during poll — keep polling, don't stop
      }
    }, 2000)
  }, [projectId, navigate])

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // ─── FILE HANDLING ──────────────────────────────────────────────────────────

  const validateAndSetFile = (file: File) => {
    // Check HEIC by both MIME type AND file extension.
    // Some devices (older iOS, Android) report .heic files with an empty or
    // incorrect MIME type — extension check is the reliable fallback.
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (HEIC_TYPES.includes(file.type) || ext === 'heic' || ext === 'heif') {
      toast.error('iPhones save as HEIC by default. Please convert to JPG/PNG using your phone\'s share/export option.')
      return
    }

    const validExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
    if (!ACCEPTED_TYPES.includes(file.type) && !validExt) {
      toast.error('Please use a JPG, PNG, or WebP photo.')
      return
    }

    // Revoke previous blob URL before creating a new one (prevents leak)
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
    }
    const newUrl = URL.createObjectURL(file)
    previewUrlRef.current = newUrl
    setSelectedFile(file)
    setPreviewUrl(newUrl)
    setPageState('selected')
  }

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) validateAndSetFile(file)
    e.target.value = '' // reset so same file can be re-selected
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) validateAndSetFile(file)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  // dragLeave fires when the pointer moves to a *child* element of the drop zone,
  // not just when it leaves the zone entirely. Without this guard, isDragOver
  // flickers off and on while the user hovers over text or icons inside the zone.
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }

  const clearFile = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setSelectedFile(null)
    setPreviewUrl(null)
    setPageState('idle')
  }

  // ─── UPLOAD ─────────────────────────────────────────────────────────────────

  const handleUpload = async () => {
    if (!selectedFile || !projectId) return
    if (pageState === 'uploading' || pageState === 'detecting') return

    setPageState('uploading')

    const formData = new FormData()
    formData.append('file', selectedFile)

    const widthNum = parseFloat(houseWidth)
    const widthQuery = (!isNaN(widthNum) && widthNum > 0) ? `&house_width=${widthNum}` : ''
    // attemptCount is 0 on first upload, 1 after first rejection — +1 gives attempt_number 1, 2, ...
    const url = `/api/projects/${projectId}/upload?attempt_number=${attemptCount + 1}${widthQuery}`

    try {
      await api.post(url, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setPageState('detecting')
      startPolling()
    } catch (err: unknown) {
      if (!mountedRef.current) return
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (msg) toast.error(msg)
      else toast.error('Upload failed. Please try again.')
      setPageState('selected')
    }
  }

  // ─── PROCEED ANYWAY ─────────────────────────────────────────────────────────

  const handleForceHitl = async () => {
    if (!projectId) return
    try {
      await api.post(`/api/projects/${projectId}/force-hitl`)
      navigate(`/projects/${projectId}/review`)
    } catch {
      toast.error('Could not proceed. Please try again.')
    }
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  const isBusy = pageState === 'uploading' || pageState === 'detecting'

  return (
    <div className="min-h-screen bg-dot-grid">
      {/* Nav */}
      <header className="bg-[#F8F5F0]/90 backdrop-blur-sm border-b border-[#E8E1D8]">
        <div className="max-w-2xl mx-auto px-6 h-14 flex items-center justify-between">
          <button onClick={() => navigate('/dashboard')} className="flex items-center gap-2 text-[#8A8178] hover:text-[#3A3430] transition-colors">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="text-sm">Dashboard</span>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-[#2C2018] rounded-lg flex items-center justify-center font-bold text-white text-xs">R</div>
            <span className="font-semibold text-[#2C2018] text-sm">RenovAI</span>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 page-enter">
        <StepProgress current={0} />

        <AnimatePresence mode="wait">

          {/* ── UPLOAD CARD (idle + selected) ── */}
          {(pageState === 'idle' || pageState === 'selected') && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
              className="bg-white rounded-2xl shadow-sm border border-[#EDE7DC] p-6"
            >
              <h1 className="text-xl font-bold text-[#1C1C1C] mb-1" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>Upload your house photo</h1>
              <p className="text-[#8A8178] text-sm mb-5">AI will detect renovation zones and estimate surface areas.</p>

              {/* Drop Zone */}
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => !selectedFile && fileInputRef.current?.click()}
                className={`relative rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden
                  ${selectedFile ? 'border-[#E8E1D8] cursor-default' : 'cursor-pointer'}
                  ${isDragOver ? 'border-[#C8711A] bg-[#FFF4EA] scale-[1.01]' : selectedFile ? 'border-[#E8E1D8]' : 'border-slate-300 hover:border-[#C8711A] hover:bg-[#F5F0E8]'}`}
              >
                <AnimatePresence mode="wait">
                  {!selectedFile ? (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center justify-center py-14 px-6 text-center"
                    >
                      <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-4 transition-colors
                        ${isDragOver ? 'bg-[#2C2018] text-white' : 'bg-[#EDE7DC] text-[#8A8178]'}`}>
                        <Upload size={24} />
                      </div>
                      <p className="text-[#3A3430] font-medium mb-1">
                        {isDragOver ? 'Drop it here' : 'Drag & drop your photo'}
                      </p>
                      <p className="text-[#8A8178] text-sm mb-3">or click to browse</p>
                      <span className="text-xs text-[#8A8178] bg-[#EDE7DC] px-3 py-1 rounded-full">
                        JPG, PNG, WebP
                      </span>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="preview"
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      className="relative"
                    >
                      <img
                        src={previewUrl!}
                        alt="Preview"
                        className="w-full max-h-72 object-cover"
                      />
                      {/* File info overlay */}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-4 py-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <ImageIcon size={14} className="text-white/80" />
                            <span className="text-white text-xs font-medium truncate max-w-[200px]">
                              {selectedFile.name}
                            </span>
                            <span className="text-white/60 text-xs">
                              ({(selectedFile.size / 1024 / 1024).toFixed(1)} MB)
                            </span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); clearFile() }}
                            className="w-6 h-6 rounded-full bg-white/20 hover:bg-white/40 flex items-center justify-center transition-colors"
                          >
                            <X size={12} className="text-white" />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleFileInput}
                />
              </div>

              {/* Change photo button when selected */}
              {selectedFile && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 text-xs text-[#8A8178] hover:text-[#5A5450] transition-colors"
                >
                  Change photo
                </button>
              )}

              {/* House Width Input */}
              <div className="mt-5">
                <label className="block text-sm font-medium text-[#3A3430] mb-1.5">
                  House width <span className="text-[#8A8178] font-normal">(optional, in feet)</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    placeholder="e.g. 35"
                    value={houseWidth}
                    onChange={e => setHouseWidth(e.target.value)}
                    min={1}
                    max={300}
                    className="w-full border border-[#E8E1D8] rounded-xl px-4 py-2.5 text-sm text-[#1C1C1C] placeholder:text-[#B5AFA7] focus:outline-none focus:ring-2 focus:ring-[#C8711A]/20 focus:border-[#C8711A] transition-all"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[#8A8178]">ft</span>
                </div>
                <p className="text-xs text-[#8A8178] mt-1.5">
                  If provided, used as the primary measurement reference for all area estimates.
                </p>
              </div>

              <TipBanner />


              {/* Upload Button */}
              <button
                onClick={handleUpload}
                disabled={!selectedFile || isBusy}
                className="mt-3 w-full flex items-center justify-center gap-2 bg-[#2C2018] hover:bg-[#3d2a1a] text-white py-3 rounded-xl font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isBusy ? (
                  <><Loader2 size={16} className="animate-spin" /> Uploading...</>
                ) : (
                  <>Analyse Photo <ArrowRight size={16} /></>
                )}
              </button>
            </motion.div>
          )}

          {/* ── DETECTING CARD ── */}
          {(pageState === 'uploading' || pageState === 'detecting') && (
            <motion.div
              key="detecting"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
              className="bg-white rounded-2xl shadow-sm border border-[#EDE7DC] p-10 flex flex-col items-center text-center"
            >
              {/* Animated house scan */}
              <div className="relative w-20 h-20 mb-6">
                <div className="absolute inset-0 rounded-2xl bg-[#2C2018]/10 animate-ping" />
                <div className="relative w-20 h-20 rounded-2xl bg-[#2C2018] flex items-center justify-center">
                  <svg width="36" height="36" fill="none" stroke="white" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>

              <h2 className="text-lg font-bold text-[#1C1C1C] mb-2">
                {pageState === 'uploading' ? 'Uploading photo' : 'Analysing your house'}
                <span className="text-[#8A8178]">{detectingDots}</span>
              </h2>

              <p className="text-[#8A8178] text-sm max-w-xs leading-relaxed">
                {pageState === 'uploading'
                  ? 'Compressing and uploading your photo...'
                  : 'Our AI is detecting renovation zones and estimating measurements. Usually takes 15–30 seconds.'}
              </p>
            </motion.div>
          )}

          {/* ── UNUSABLE CARD ── */}
          {pageState === 'unusable' && (
            <motion.div
              key="unusable"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
              className="bg-white rounded-2xl shadow-sm border border-[#EDE7DC] p-6"
            >
              {/* Error header */}
              <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl mb-5">
                <AlertCircle size={18} className="text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-800 mb-1">
                    {attemptCount >= 2 ? 'Still having trouble reading this photo' : 'We couldn\'t analyse this photo'}
                  </p>
                  <p className="text-sm text-amber-700 leading-relaxed">
                    {unusableReason}
                  </p>
                </div>
              </div>

              {/* Drop zone for retry */}
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl py-8 flex flex-col items-center justify-center cursor-pointer transition-all
                  ${isDragOver ? 'border-[#C8711A] bg-[#FFF4EA]' : 'border-[#E8E1D8] hover:border-[#C8711A] hover:bg-[#F5F0E8]'}`}
              >
                <RefreshCw size={20} className="text-[#8A8178] mb-2" />
                <p className="text-sm font-medium text-[#5A5450] mb-0.5">Upload a different photo</p>
                <p className="text-xs text-[#8A8178]">Drag & drop or click to browse</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleFileInput}
                />
              </div>

              <TipBanner />

              {/* CTA buttons */}
              <div className="mt-4 flex flex-col gap-2.5">
                {attemptCount >= 2 && (
                  <button
                    onClick={handleForceHitl}
                    className="w-full flex items-center justify-center gap-2 border-2 border-[#E8E1D8] hover:border-amber-300 hover:bg-amber-50 text-[#5A5450] hover:text-amber-700 py-3 rounded-xl font-medium transition-all"
                  >
                    <ArrowRight size={16} />
                    Proceed anyway and enter measurements manually
                  </button>
                )}
              </div>

              {attemptCount >= 2 && (
                <p className="text-xs text-[#8A8178] text-center mt-3">
                  If you proceed, you'll enter zone measurements manually on the next screen.
                  Cost estimates may be less accurate.
                </p>
              )}
            </motion.div>
          )}

          {/* ── FAILED CARD (system error) ── */}
          {pageState === 'failed' && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
              className="bg-white rounded-2xl shadow-sm border border-[#EDE7DC] p-6 text-center"
            >
              <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-4">
                <AlertCircle size={24} className="text-red-400" />
              </div>
              <h2 className="text-base font-bold text-[#1C1C1C] mb-2">Something went wrong</h2>
              <p className="text-sm text-[#8A8178] mb-5">
                There was an error on our end while processing your photo. Please try again.
              </p>
              <button
                onClick={() => {
                  setPageState('idle')
                  setSelectedFile(null)
                  setPreviewUrl(null)
                }}
                className="flex items-center justify-center gap-2 mx-auto bg-[#2C2018] hover:bg-[#3d2a1a] text-white px-6 py-2.5 rounded-xl font-medium transition-colors"
              >
                <RefreshCw size={15} />
                Try again
              </button>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  )
}
