/**
 * AuthContext — single source of truth for auth state.
 *
 * Fast load strategy:
 * - On mount, reads both token + user from localStorage immediately → no spinner
 * - Validates token with GET /auth/me in the background → refreshes user data
 * - On 401: clears session and redirects to login
 * - On network error: keeps stored session (server may be slow to start)
 *
 * Race condition protection:
 * - AbortController cancels the /me call if component unmounts mid-request
 * - All consumers read from context — no component-local auth state
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import api from '@/services/api'

interface User {
  id: string
  email: string
  name: string
  credits: number
}

interface AuthContextValue {
  user: User | null
  token: string | null
  isLoading: boolean
  login: (token: string, user: User) => void
  logout: () => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const storedToken = localStorage.getItem('auth_token')
    const storedUser  = localStorage.getItem('auth_user')

    if (!storedToken) {
      setIsLoading(false)
      return
    }

    // Optimistic restore — show app immediately without waiting for /auth/me
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser))
        setToken(storedToken)
      } catch { /* ignore corrupted entry */ }
    }
    setIsLoading(false)  // unblock ProtectedRoute right away

    // Background validation — refreshes user data (credits etc.) and catches expired tokens
    abortRef.current = new AbortController()
    api
      .get('/auth/me', { signal: abortRef.current.signal })
      .then((res: { data: User }) => {
        setToken(storedToken)
        setUser(res.data)
        localStorage.setItem('auth_user', JSON.stringify(res.data))
      })
      .catch((err: any) => {
        // Only hard-logout on explicit 401 — network errors keep the cached session
        if (err?.response?.status === 401) {
          localStorage.removeItem('auth_token')
          localStorage.removeItem('auth_user')
          setToken(null)
          setUser(null)
        }
      })

    return () => { abortRef.current?.abort() }
  }, [])

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('auth_token', newToken)
    localStorage.setItem('auth_user', JSON.stringify(newUser))
    setToken(newToken)
    setUser(newUser)
  }

  const logout = () => {
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_user')
    setToken(null)
    setUser(null)
  }

  const refreshUser = async () => {
    try {
      const res = await api.get('/auth/me')
      setUser(res.data)
      localStorage.setItem('auth_user', JSON.stringify(res.data))
    } catch (err: any) {
      if (err?.response?.status === 401) logout()
    }
  }

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
