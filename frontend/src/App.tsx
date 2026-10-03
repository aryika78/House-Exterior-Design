import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from '@/components/shared/ProtectedRoute'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import UploadPage from '@/pages/UploadPage'
import HITLPage from '@/pages/HITLPage'
import MaterialSelectionPage from '@/pages/MaterialSelectionPage'
import ResultPage from '@/pages/ResultPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
        <Route path="/projects/:id/upload" element={<ProtectedRoute><UploadPage /></ProtectedRoute>} />
        <Route path="/projects/:id/review" element={<ProtectedRoute><HITLPage /></ProtectedRoute>} />
        <Route path="/projects/:id/materials" element={<ProtectedRoute><MaterialSelectionPage /></ProtectedRoute>} />
        <Route path="/projects/:id/result" element={<ProtectedRoute><ResultPage /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  )
}
