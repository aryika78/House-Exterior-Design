import axios from 'axios'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

const api = axios.create({
  baseURL: BASE_URL,
})

// Attach auth token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle token expiry globally.
// A 401 on any protected call means the JWT expired or was tampered with.
// Clear the token and redirect to /login so the user re-authenticates cleanly
// instead of seeing a cryptic "Invalid or expired token" toast on every page.
// Guard: skip redirect if already on /login (would cause an infinite redirect loop).
api.interceptors.response.use(
  response => response,
  error => {
    if (
      error.response?.status === 401 &&
      window.location.pathname !== '/login'
    ) {
      localStorage.removeItem('auth_token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api
