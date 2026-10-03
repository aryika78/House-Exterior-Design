/**
 * Dashboard — lists all user projects + credits.
 *
 * Race conditions:
 * - React Query handles deduplication + stale-while-revalidate
 * - New project creation disables button until response arrives
 * - No stale data: invalidates projects query after create
 * - Auto-refetches every 8s when any project is in a transient state
 */
import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

const IMAGE_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

// Images are now Supabase public URLs (https://...). Fall back to prefixing with
// IMAGE_BASE only for legacy local-path values stored before this migration.
function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return `${IMAGE_BASE}/${url}`
}
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import {
  Plus, LogOut, Zap, Clock, CheckCircle2, AlertCircle,
  Loader2, Download, ArrowRight,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import api from '@/services/api'

// ─── constants ────────────────────────────────────────────────────────────────

const TRANSIENT_STATUSES = new Set(['detecting', 'rendering'])

const STATUS_META: Record<string, { label: string; dotColor: string; badgeColor: string; icon: React.ReactNode }> = {
  pending:            { label: 'Draft',           dotColor: 'bg-[#B5AFA7]',  badgeColor: 'bg-[#EDE7DC] text-[#5A5450]',   icon: <Clock size={12} /> },
  detecting:          { label: 'Detecting zones', dotColor: 'bg-amber-400',   badgeColor: 'bg-[#FFF4EA] text-[#C8711A]',     icon: <Loader2 size={12} className="animate-spin" /> },
  hitl:               { label: 'Review needed',   dotColor: 'bg-amber-500',  badgeColor: 'bg-amber-100 text-amber-700',   icon: <AlertCircle size={12} /> },
  material_selection: { label: 'Pick materials',  dotColor: 'bg-purple-500', badgeColor: 'bg-purple-100 text-purple-700', icon: <AlertCircle size={12} /> },
  rendering:          { label: 'Rendering',       dotColor: 'bg-amber-400',   badgeColor: 'bg-[#FFF4EA] text-[#C8711A]',     icon: <Loader2 size={12} className="animate-spin" /> },
  completed:          { label: 'Completed',       dotColor: 'bg-green-500',  badgeColor: 'bg-green-100 text-green-700',   icon: <CheckCircle2 size={12} /> },
  failed:             { label: 'Failed',          dotColor: 'bg-red-400',    badgeColor: 'bg-red-100 text-red-700',       icon: <AlertCircle size={12} /> },
}

const RESUME_LABEL: Record<string, string> = {
  pending:            'Upload photo',
  hitl:               'Review zones',
  material_selection: 'Pick materials',
}

const TIER_LABEL: Record<string, string> = {
  economy:  'Economy',
  standard: 'Standard',
  premium:  'Premium',
}

type FilterTab = 'all' | 'in_progress' | 'completed' | 'failed'

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'all',         label: 'All' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'completed',   label: 'Completed' },
  { id: 'failed',      label: 'Failed' },
]

function matchesFilter(status: string, tab: FilterTab) {
  if (tab === 'all') return true
  if (tab === 'in_progress') return ['pending', 'detecting', 'hitl', 'material_selection', 'rendering'].includes(status)
  if (tab === 'completed') return status === 'completed'
  if (tab === 'failed') return status === 'failed'
  return true
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── skeleton ────────────────────────────────────────────────────────────────

function ProjectCardSkeleton() {
  return (
    <div className="bg-white rounded-2xl overflow-hidden border border-[#EDE7DC]">
      <div className="skeleton h-40 w-full" />
      <div className="p-4 space-y-2">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-3 w-1/3" />
      </div>
    </div>
  )
}

// ─── card ─────────────────────────────────────────────────────────────────────

function ProjectCard({ project }: { project: any }) {
  const navigate = useNavigate()
  const meta = STATUS_META[project.status] || STATUS_META.pending

  const resumeLabel = RESUME_LABEL[project.status]
  const isTransient  = TRANSIENT_STATUSES.has(project.status)
  const isCompleted  = project.status === 'completed'
  const tierLabel    = project.tier ? TIER_LABEL[project.tier] : null

  const handleClick = () => {
    switch (project.status) {
      case 'pending':            return navigate(`/projects/${project.id}/upload`)
      case 'detecting':          return navigate(`/projects/${project.id}/upload`)
      case 'hitl':               return navigate(`/projects/${project.id}/review`)
      case 'material_selection': return navigate(`/projects/${project.id}/materials`)
      default:                   return navigate(`/projects/${project.id}/result`)
    }
  }

  const handlePdfClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/projects/${project.id}/result`)
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      whileHover={{ y: -3, boxShadow: '0 10px 40px rgba(26,46,68,0.10)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      onClick={handleClick}
      className="bg-white rounded-2xl overflow-hidden cursor-pointer border border-[#EDE7DC] hover:border-[#E8E1D8] transition-all flex flex-col shadow-sm hover:shadow-md"
    >
      {/* Image */}
      <div className="h-40 bg-gradient-to-br from-[#EDE7DC] to-[#E3DAD0] relative overflow-hidden flex-shrink-0">
        {project.render_image_url ? (
          <img src={resolveImageUrl(project.render_image_url)!} alt="render" className="w-full h-full object-cover" />
        ) : project.original_image_url ? (
          <img src={resolveImageUrl(project.original_image_url)!} alt="original" className="w-full h-full object-cover" />
        ) : (
          <div className="flex items-center justify-center h-full text-[#B5AFA7]">
            <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 19.5h18M3 4.5h18" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {/* Status badge — top left */}
        <div className={`absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium backdrop-blur-sm ${meta.badgeColor}`}>
          {meta.icon}
          {meta.label}
        </div>

        {/* Tier badge — top right (completed only) */}
        {isCompleted && tierLabel && (
          <div className="absolute top-3 right-3 px-2 py-1 rounded-full text-[11px] font-medium bg-[#2C2018]/80 text-white backdrop-blur-sm">
            {tierLabel}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 flex flex-col gap-3 flex-1">
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-[#1C1C1C] leading-tight">
              Project · {formatDate(project.created_at)}
            </p>
            {project.total_cost && (
              <p className="text-xs font-semibold text-[#e07b39] mt-0.5">
                ₹{Number(project.total_cost).toLocaleString('en-IN')}
              </p>
            )}
          </div>
          {/* PDF icon for completed */}
          {isCompleted && (
            <button
              onClick={handlePdfClick}
              className="p-1.5 rounded-lg text-[#8A8178] hover:text-[#2C2018] hover:bg-[#EDE7DC] transition-colors flex-shrink-0"
              title="View report"
            >
              <Download size={14} />
            </button>
          )}
        </div>

        {/* CTA row — resume or transient */}
        {resumeLabel && (
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#2C2018] mt-auto">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dotColor}`} />
            {resumeLabel}
            <ArrowRight size={11} className="ml-0.5" />
          </div>
        )}
        {isTransient && (
          <div className="flex items-center gap-1.5 text-xs text-[#8A8178] mt-auto">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dotColor} animate-pulse`} />
            Processing in background…
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ─── empty states ─────────────────────────────────────────────────────────────

function EmptyAll({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-24 text-center"
    >
      <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center mb-5 shadow-sm border border-[#E8E1D8]">
        <svg width="40" height="40" fill="none" stroke="#B5AFA7" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h3 className="text-lg font-bold text-[#1C1C1C] mb-2" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
        Your first project is one photo away
      </h3>
      <p className="text-[#8A8178] mb-6 max-w-xs text-sm">
        Snap your home's exterior. AI does the rest.
      </p>
      <button
        onClick={onCreate}
        disabled={creating}
        className="flex items-center gap-2 bg-[#2C2018] hover:bg-[#3d2a1a] text-white px-6 py-3 rounded-xl font-medium transition-colors disabled:opacity-60"
      >
        <Plus size={16} />
        Start your first project
      </button>
    </motion.div>
  )
}

function EmptyFilter({ tab }: { tab: FilterTab }) {
  const msg: Record<FilterTab, string> = {
    all:         '',
    in_progress: 'No projects in progress.',
    completed:   'No completed projects yet.',
    failed:      'No failed projects.',
  }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="py-20 text-center text-[#8A8178] text-sm"
    >
      {msg[tab]}
    </motion.div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [creating, setCreating]     = useState(false)
  const [activeTab, setActiveTab]   = useState<FilterTab>('all')

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get('/api/projects').then((r: { data: unknown[] }) => r.data),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // Auto-poll while any project is in a transient (background-processing) state
    refetchInterval: (query) => {
      const list = query.state.data as any[] | undefined
      if (!list) return false
      return list.some((p: any) => TRANSIENT_STATUSES.has(p.status)) ? 8_000 : false
    },
  })

  const filtered = useMemo(
    () => (projects as any[]).filter(p => matchesFilter(p.status, activeTab)),
    [projects, activeTab],
  )

  // Count badges for filter tabs
  const counts = useMemo(() => ({
    in_progress: (projects as any[]).filter(p => matchesFilter(p.status, 'in_progress')).length,
    completed:   (projects as any[]).filter(p => p.status === 'completed').length,
    failed:      (projects as any[]).filter(p => p.status === 'failed').length,
  }), [projects])

  const credits = user?.credits ?? 0
  const lowCredits = credits <= 1

  const handleNewProject = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await api.post('/api/projects')
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${res.data.id}/upload`)
    } catch {
      toast.error('Could not create project. Try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen bg-dot-grid">
      {/* Top nav */}
      <header className="bg-[#F8F5F0]/90 backdrop-blur-sm border-b border-[#E8E1D8] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[#2C2018] text-lg">RenovAI</span>
            <div className="w-8 h-8 bg-[#2C2018] rounded-lg flex items-center justify-center font-bold text-white text-sm">R</div>
          </div>
          <div className="flex items-center gap-4">
            {/* Credits pill with tooltip */}
            <div className="relative group cursor-default">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border ${
                lowCredits ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'
              }`}>
                <Zap size={14} className={lowCredits ? 'text-red-500' : 'text-amber-500'} />
                <span className={`text-sm font-semibold ${lowCredits ? 'text-red-700' : 'text-amber-700'}`}>
                  {credits} credit{credits !== 1 ? 's' : ''}
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
            {/* User avatar */}
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-[#2C2018] flex items-center justify-center text-white text-sm font-medium">
                {user?.name?.[0]?.toUpperCase() ?? 'U'}
              </div>
              <span className="text-sm text-[#5A5450] hidden sm:block">{user?.name}</span>
            </div>
            <button
              onClick={logout}
              className="p-2 rounded-lg text-[#8A8178] hover:text-[#5A5450] hover:bg-[#EDE7DC] transition-colors"
              title="Sign out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Low credits warning banner */}
      {lowCredits && !isLoading && (
        <div className="bg-red-50 border-b border-red-100">
          <div className="max-w-6xl mx-auto px-6 py-2.5 flex items-center gap-2 text-sm text-red-700">
            <AlertCircle size={14} className="flex-shrink-0" />
            {credits === 0
              ? 'You have no credits remaining. Contact support to top up.'
              : 'You have 1 credit remaining.'}
          </div>
        </div>
      )}

      {/* Main */}
      <main className="max-w-6xl mx-auto px-6 py-8 page-enter">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="label-eyebrow mb-1">
              {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <h1 className="text-2xl font-bold text-[#1C1C1C]" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
              {user?.name ? `${new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening'}, ${user.name.split(' ')[0]}` : 'Your projects'}
            </h1>
          </div>
          <button
            onClick={handleNewProject}
            disabled={creating || credits === 0}
            className="flex items-center gap-2 bg-[#2C2018] hover:bg-[#3d2a1a] text-white px-5 py-2.5 rounded-xl font-medium transition-all shadow-sm hover:shadow disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {creating ? 'Creating…' : 'New Project'}
          </button>
        </div>

        {/* Filter tabs */}
        {!isLoading && (projects as any[]).length > 0 && (
          <div className="flex items-center gap-1 mb-6 bg-white border border-[#E8E1D8] rounded-xl p-1 w-fit">
            {FILTER_TABS.map(tab => {
              const count = tab.id !== 'all' ? counts[tab.id as keyof typeof counts] : undefined
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-[#2C2018] text-white shadow-sm'
                      : 'text-[#8A8178] hover:text-[#3A3430] hover:bg-[#F5F0E8]'
                  }`}
                >
                  {tab.label}
                  {count !== undefined && count > 0 && (
                    <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${
                      isActive ? 'bg-white/20 text-white' : 'bg-[#EDE7DC] text-[#8A8178]'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map(i => <ProjectCardSkeleton key={i} />)}
          </div>
        ) : (projects as any[]).length === 0 ? (
          <EmptyAll onCreate={handleNewProject} creating={creating} />
        ) : filtered.length === 0 ? (
          <EmptyFilter tab={activeTab} />
        ) : (
          <AnimatePresence mode="popLayout">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filtered.map((p: any) => <ProjectCard key={p.id} project={p} />)}
            </div>
          </AnimatePresence>
        )}
      </main>
    </div>
  )
}
