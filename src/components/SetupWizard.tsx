import React, { useState } from 'react'
import { Store, ShieldCheck, Sparkles, ArrowRight } from 'lucide-react'

export function SetupWizard({ onComplete }: { onComplete: (businessName: string) => void }) {
  const [businessName, setBusinessName] = useState('New Road Electronics 🇳🇵')
  const [adminUsername, setAdminUsername] = useState('kathmandu_store')
  const [password, setPassword] = useState('admin123')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName, adminUsername, password }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        onComplete(businessName)
      } else {
        setError(data.error || 'Failed to complete setup')
      }
    } catch (err: any) {
      setError(err?.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-2">
            <Store className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Chatze (Nepal Edition)</h1>
          <p className="text-sm text-slate-400">
            60-Second Setup • Zero-Config Cloudflare Edge & D1 Database
          </p>
        </div>

        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Shop / Business Name</label>
            <input
              type="text"
              required
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. New Road Electronics"
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Admin Username</label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-slate-500 text-sm">@</span>
              <input
                type="text"
                required
                value={adminUsername}
                onChange={(e) => setAdminUsername(e.target.value)}
                placeholder="store_admin"
                className="w-full pl-8 pr-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
            />
          </div>

          <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl space-y-1.5 text-xs text-slate-400">
            <div className="flex items-center gap-2 text-emerald-400 font-medium">
              <ShieldCheck className="w-4 h-4" /> Cloudflare Edge Features Ready:
            </div>
            <ul className="list-disc list-inside space-y-0.5 pl-1 text-[11px]">
              <li>Kathmandu (KTM) PoP Routing (5ms–20ms ping)</li>
              <li>5 GB Free Cloudflare D1 SQLite Storage</li>
              <li>Zero External Accounts (No Neon, No Vercel)</li>
            </ul>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold rounded-xl text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/20 cursor-pointer"
          >
            {submitting ? (
              'Initializing Database...'
            ) : (
              <>
                Launch Business Inbox <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
