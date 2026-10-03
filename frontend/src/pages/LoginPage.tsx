import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/AuthContext'
import api from '@/services/api'

declare global {
  interface Window { google: any }
}

export default function LoginPage() {
  const { login, user } = useAuth()
  const navigate = useNavigate()
  const [isLoading, setIsLoading] = useState(false)
  const [googleFailed, setGoogleFailed] = useState(false)
  const googleBtnRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true })
  }, [user, navigate])

  useEffect(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
    if (!clientId) return

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => {
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleResponse,
        })
        if (googleBtnRef.current) {
          window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: 'outline',
            size: 'large',
            width: 280,
            text: 'continue_with',
            shape: 'rectangular',
          })
        }
      } catch {
        setGoogleFailed(true)
      }
    }
    script.onerror = () => setGoogleFailed(true)
    document.head.appendChild(script)

    const timer = setTimeout(() => {
      if (googleBtnRef.current && googleBtnRef.current.children.length === 0) {
        setGoogleFailed(true)
      }
    }, 2000)

    return () => {
      clearTimeout(timer)
      if (document.head.contains(script)) document.head.removeChild(script)
    }
  }, [])

  const handleGoogleResponse = async (response: { credential: string }) => {
    if (isLoading) return
    setIsLoading(true)
    try {
      const res = await api.post('/auth/google', { id_token: response.credential })
      login(res.data.access_token, res.data.user)
      navigate('/dashboard', { replace: true })
    } catch {
      toast.error('Sign-in failed. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const SignInButton = () => (
    import.meta.env.VITE_GOOGLE_CLIENT_ID && !googleFailed ? (
      <div ref={googleBtnRef} className="flex justify-center min-h-[44px]" />
    ) : (
      <button
        onClick={async () => {
          setIsLoading(true)
          try {
            const res = await api.get('/auth/me')
            login('dev-token', res.data)
            navigate('/dashboard', { replace: true })
          } catch {
            toast.error('Could not connect to backend. Is it running?')
          } finally {
            setIsLoading(false)
          }
        }}
        disabled={isLoading}
        className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-[#E8E1D8] bg-white hover:bg-[#F8F5F0] transition-all font-medium text-[#1C1C1C] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
      >
        {isLoading ? (
          <div className="w-5 h-5 border-2 border-[#8A8178] border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
        )}
        {isLoading ? 'Signing in...' : 'Continue with Google'}
      </button>
    )
  )

  return (
    <div className="min-h-screen flex">

      {/* ── Left: hero image (60%) — visible from md (768px) up ── */}
      <div className="hidden md:block relative flex-1 overflow-hidden">
        <img
          src="/hero.jpg"
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-black/65 via-black/40 to-black/25" />

        {/* Logo */}
        <div className="absolute top-8 left-8 z-10 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-[#4E7A9E] rounded-lg flex items-center justify-center font-bold text-white text-sm">R</div>
          <span className="text-white text-lg font-semibold tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
            RenovAI
          </span>
        </div>

        {/* Tagline */}
        <div className="absolute bottom-10 left-10 z-10 max-w-sm">
          <p className="text-white/50 text-xs font-semibold tracking-[0.14em] uppercase mb-2">
            Exterior Renovation, Visualised
          </p>
          <h1
            className="text-white text-4xl font-normal italic leading-tight"
            style={{ fontFamily: "'Playfair Display', ui-serif, Georgia, serif" }}
          >
            See it before<br />you build it.
          </h1>
          <p className="text-white/60 text-sm mt-3 leading-relaxed">
            Upload your facade. AI maps every surface.<br />
            Pick materials, see the render, get a cost estimate.
          </p>
        </div>
      </div>

      {/* ── Right: login panel (40%) — full width on mobile ── */}
      <div className="w-full md:w-[440px] md:shrink-0 flex flex-col items-center justify-center min-h-screen relative">

        {/* Mobile: image background */}
        <div className="absolute inset-0 md:hidden">
          <img src="/hero.jpg" alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/55" />
        </div>

        {/* Desktop: warm cream background */}
        <div className="absolute inset-0 hidden md:block bg-[#F5F0E8]" />

        {/* Content */}
        <div className="relative z-10 w-full px-8 flex flex-col items-center">

          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-10 md:hidden">
            <div className="w-8 h-8 bg-[#4E7A9E] rounded-lg flex items-center justify-center font-bold text-white text-sm">R</div>
            <span className="font-semibold text-white text-lg tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
              RenovAI
            </span>
          </div>

          <motion.div
            className="w-full max-w-[300px]"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
          >
            {/* Mobile: white card. Desktop: flat on cream bg */}
            <div className="md:bg-transparent bg-white/95 backdrop-blur-md md:backdrop-blur-none rounded-2xl p-7 md:p-0 shadow-2xl md:shadow-none">
              <h2
                className="text-2xl font-bold text-[#1C1C1C] mb-1"
                style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}
              >
                Welcome
              </h2>
              <p className="text-[#8A8178] text-sm mb-8">
                Sign in with Google to get started.
              </p>
              <SignInButton />
            </div>
          </motion.div>

        </div>
      </div>

    </div>
  )
}
