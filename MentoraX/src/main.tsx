import React from 'react'
import ReactDOM from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import App from './App.tsx'
import './index.css'

// Ideally this comes from import.meta.env.VITE_GOOGLE_CLIENT_ID, but for the hackathon prototype we'll hardcode or use the env.
// In Vite, env vars must be prefixed with VITE_. Since we didn't prefix it in .env, we can just hardcode the provided client ID here for extreme ease of running the demo, or require the user to rename it in .env.
const GOOGLE_CLIENT_ID = '892099831581-qir54qg7jph9aq8g7fgnc56ekp2flvai.apps.googleusercontent.com'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  </React.StrictMode>,
)
