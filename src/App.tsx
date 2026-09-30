import React, { useState, useEffect } from 'react'
import { SetupWizard } from './components/SetupWizard'
import { AuthScreens } from './components/AuthScreens'
import { MessagingApp } from './components/MessagingApp'

export function App() {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null)
  const [businessName, setBusinessName] = useState('New Road Electronics 🇳🇵')
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function checkState() {
      try {
        const setupRes = await fetch('/api/setup/status')
        const setupData = await setupRes.json()
        if (setupData.setupRequired) {
          setSetupRequired(true)
          setLoading(false)
          return
        }
        setSetupRequired(false)
        if (setupData.businessName) setBusinessName(setupData.businessName)

        // Check session
        const sessionRes = await fetch('/api/auth/session')
        if (sessionRes.ok) {
          const sessionData = await sessionRes.json()
          if (sessionData.user) {
            setCurrentUser(sessionData.user)
          }
        }
      } catch (err) {
        console.error('App init error', err)
      } finally {
        setLoading(false)
      }
    }
    checkState()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-3">
        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-medium tracking-wide">Connecting to Kathmandu Edge...</p>
      </div>
    )
  }

  if (setupRequired) {
    return (
      <SetupWizard
        onComplete={(bName) => {
          setBusinessName(bName)
          setSetupRequired(false)
          // Default admin profile after setup
          setCurrentUser({
            id: 'usr_admin',
            handle: 'kathmandu_store',
            display_name: bName,
            role: 'admin',
          })
        }}
      />
    )
  }

  if (!currentUser) {
    return <AuthScreens onLoginSuccess={(user) => setCurrentUser(user)} />
  }

  return (
    <MessagingApp
      currentUser={currentUser}
      businessName={businessName}
      onLogout={() => setCurrentUser(null)}
    />
  )
}

export default App
