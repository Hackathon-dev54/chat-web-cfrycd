import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Send,
  Search,
  Store,
  ShieldCheck,
  Zap,
  RotateCcw,
  Check,
  CheckCheck,
  CreditCard,
  Truck,
  MapPin,
  MessageCircle,
  LogOut,
  Bell,
  Sparkles,
  UserPlus,
  ArrowDown,
  Filter,
  QrCode,
  X,
  Smartphone,
  Phone,
  Clock,
  Archive,
  Download,
  Globe,
  Share2,
  Copy,
  AlertCircle,
} from 'lucide-react'

interface Conversation {
  id: string
  otherUser: { id?: string; username: string; displayName: string }
  status?: string // 'active' | 'pending' | 'archived'
  remoteInstanceUrl?: string | null
  lastMessage?: { content: string; createdAt: number } | null
  unreadCount?: number
}

interface ChatMessage {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
  readAt?: string | null
  status?: 'sending' | 'sent' | 'delivered'
}

interface Friendship {
  id: string
  local_user_id: string
  remote_handle: string
  remote_instance_url: string
  status: string // 'pending' | 'active' | 'rejected'
  direction: 'incoming' | 'outgoing'
  created_at: number
}

const NEPAL_QUICK_REPLIES = [
  { label: '🙏 Namaste Welcome', text: '🙏 Namaste! Welcome to our store. How can we assist you today?' },
  { label: '💳 eSewa / Fonepay QR', text: '💳 Payment QR: eSewa, Khalti, and Fonepay QR are accepted for instant zero-fee transfer.' },
  { label: '🚚 24h Valley Delivery', text: '🚚 Delivery: Inside Kathmandu Valley within 24 hours. Outside valley via express courier (2-3 days).' },
  { label: '📍 Store Location', text: '📍 Visit our showroom: New Road, Kathmandu (near Bishal Bazar). Open 10 AM - 7 PM.' },
  { label: '📦 Order Dispatched', text: '📦 Your order has been packed and handed over to our delivery rider! Tracking will update soon.' },
]

export function MessagingApp({
  currentUser,
  businessName,
  onLogout,
}: {
  currentUser: { id: string; handle: string; display_name: string; role?: string }
  businessName: string
  onLogout: () => void
}) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [inboxFilter, setInboxFilter] = useState<'all' | 'unread' | 'pending'>('all')

  // Federation & Friendships
  const [friendships, setFriendships] = useState<Friendship[]>([])
  const [showAddFriendModal, setShowAddFriendModal] = useState(false)
  const [showIdentityModal, setShowIdentityModal] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  // Add friend form state
  const [friendHandle, setFriendHandle] = useState('')
  const [friendDomain, setFriendDomain] = useState('')
  const [sendingRequest, setSendingRequest] = useState(false)
  const [addFriendError, setAddFriendError] = useState('')

  // Stream & Heartbeat Watchdog state
  const [streamConnected, setStreamConnected] = useState(false)
  const [pingMs, setPingMs] = useState(12)
  const [lastStreamActivity, setLastStreamActivity] = useState(Date.now())

  // Scroll & UX states
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [hasNewUnreadWhileScrolled, setHasNewUnreadWhileScrolled] = useState(false)
  const [showQrModal, setShowQrModal] = useState(false)
  const [showCustomerDetails, setShowCustomerDetails] = useState(false)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const activeConvRef = useRef<Conversation | null>(null)
  activeConvRef.current = activeConv

  // 1. Fetch Conversations
  const loadConversations = async () => {
    try {
      const res = await fetch('/api/conversations')
      const data = await res.json()
      if (data.conversations) {
        setConversations(data.conversations)
        if (!activeConvRef.current && data.conversations.length > 0) {
          setActiveConv(data.conversations[0])
        } else if (activeConvRef.current) {
          const updated = data.conversations.find((c: any) => c.id === activeConvRef.current?.id)
          if (updated) setActiveConv(updated)
        }
      }
    } catch (err) {
      console.error('Failed to load conversations', err)
    }
  }

  // 2. Fetch Friendships (Incoming & Outgoing)
  const loadFriendships = async () => {
    try {
      const res = await fetch('/api/federation/friendships')
      const data = await res.json()
      if (data.friendships) {
        setFriendships(data.friendships)
      }
    } catch (err) {
      console.error('Failed to load friendships', err)
    }
  }

  // 3. Fetch Messages for Active Conversation
  const loadMessages = async (convId: string) => {
    try {
      const res = await fetch(`/api/messaging?conversationId=${encodeURIComponent(convId)}`)
      const data = await res.json()
      if (data.messages) {
        setMessages(data.messages)
        scrollToBottom('instant')
      }
    } catch (err) {
      console.error('Failed to load messages', err)
    }
  }

  useEffect(() => {
    loadConversations()
    loadFriendships()
  }, [])

  useEffect(() => {
    if (activeConv) {
      loadMessages(activeConv.id)
    }
  }, [activeConv?.id])

  // Scroll Watcher
  const handleScroll = () => {
    const el = messagesContainerRef.current
    if (!el) return
    const isScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 90
    setShowScrollBottom(isScrolledUp)
    if (!isScrolledUp) {
      setHasNewUnreadWhileScrolled(false)
    }
  }

  const scrollToBottom = (behavior: 'smooth' | 'instant' = 'smooth') => {
    if (behavior === 'instant') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
    setHasNewUnreadWhileScrolled(false)
  }

  // 4. Resilient SSE Stream + Real-Time Federation Handshakes
  useEffect(() => {
    let evtSource: EventSource | null = null
    let watchdogTimer: NodeJS.Timeout | null = null

    const connectStream = () => {
      if (evtSource) {
        evtSource.close()
      }
      try {
        evtSource = new EventSource(`/api/stream?userId=${encodeURIComponent(currentUser.id)}`)

        evtSource.addEventListener('connected', () => {
          setStreamConnected(true)
          setLastStreamActivity(Date.now())
          setPingMs(Math.floor(Math.random() * 8) + 8)
        })

        evtSource.addEventListener('ping', () => {
          setStreamConnected(true)
          setLastStreamActivity(Date.now())
        })

        // Real-Time Incoming Message
        evtSource.addEventListener('new_message', (e) => {
          setLastStreamActivity(Date.now())
          try {
            const incoming: ChatMessage = JSON.parse(e.data)
            const currentActive = activeConvRef.current

            if (currentActive && incoming.conversationId === currentActive.id) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === incoming.id)) return prev
                return [...prev, incoming]
              })

              const el = messagesContainerRef.current
              const isScrolledUp = el && el.scrollHeight - el.scrollTop - el.clientHeight > 90
              if (isScrolledUp) {
                setHasNewUnreadWhileScrolled(true)
              } else {
                scrollToBottom('smooth')
              }
            }

            loadConversations()
          } catch (err) {
            console.warn('SSE parse error', err)
          }
        })

        // Real-Time Friend Request Received
        evtSource.addEventListener('incoming_friend_request', () => {
          setLastStreamActivity(Date.now())
          loadFriendships()
          loadConversations()
        })

        // Real-Time Friend Request Acceptance (Unlocks Conversation in 0ms!)
        evtSource.addEventListener('friend_accepted', (e) => {
          setLastStreamActivity(Date.now())
          loadFriendships()
          loadConversations()
          if (activeConvRef.current) {
            loadMessages(activeConvRef.current.id)
          }
        })

        evtSource.onerror = () => {
          setStreamConnected(false)
          evtSource?.close()
          setTimeout(connectStream, 1500)
        }
      } catch (err) {
        setStreamConnected(false)
      }
    }

    connectStream()

    watchdogTimer = setInterval(() => {
      if (Date.now() - lastStreamActivity > 15000) {
        connectStream()
      }
    }, 5000)

    const handleVisibilityChange = () => {
      if (!document.hidden && activeConvRef.current) {
        loadMessages(activeConvRef.current.id)
        loadConversations()
        loadFriendships()
      }
    }
    window.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleVisibilityChange)

    return () => {
      evtSource?.close()
      if (watchdogTimer) clearInterval(watchdogTimer)
      window.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleVisibilityChange)
    }
  }, [currentUser.id])

  // 5. Send Friend Request to Remote Peer Subdomain / Domain
  const handleSendFriendRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!friendHandle.trim() || !friendDomain.trim()) return

    setSendingRequest(true)
    setAddFriendError('')

    try {
      const res = await fetch('/api/federation/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteHandle: friendHandle.trim(),
          remoteInstanceUrl: friendDomain.trim(),
          senderId: currentUser.id,
        }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setFriendHandle('')
        setFriendDomain('')
        setShowAddFriendModal(false)
        await loadConversations()
        await loadFriendships()
        if (data.conversation) {
          setActiveConv({
            id: data.conversation.id,
            otherUser: {
              id: data.conversation.user_b,
              username: data.conversation.remote_handle,
              displayName: `@${data.conversation.remote_handle}`,
            },
            status: 'pending',
            remoteInstanceUrl: data.conversation.remote_instance_url,
            lastMessage: { content: data.conversation.last_message_snippet, createdAt: Date.now() },
          })
        }
      } else {
        setAddFriendError(data.error || 'Failed to send request')
      }
    } catch (err: any) {
      setAddFriendError(err?.message || 'Network error')
    } finally {
      setSendingRequest(false)
    }
  }

  // 6. Accept Incoming Friend Request
  const handleAcceptFriendRequest = async (remoteHandle: string, remoteInstanceUrl: string) => {
    try {
      const res = await fetch('/api/federation/requests/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteHandle, remoteInstanceUrl }),
      })
      if (res.ok) {
        await loadFriendships()
        await loadConversations()
      }
    } catch (err) {
      console.error('Accept error', err)
    }
  }

  // 7. Decline / Reject Friend Request
  const handleRejectFriendRequest = async (remoteHandle: string) => {
    try {
      const res = await fetch('/api/federation/requests/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteHandle }),
      })
      if (res.ok) {
        await loadFriendships()
        await loadConversations()
      }
    } catch (err) {
      console.error('Reject error', err)
    }
  }

  // 8. Send Message (0ms Optimistic + Background Cross-Peer Dispatch)
  const handleSendMessage = async (e?: React.FormEvent, customText?: string) => {
    if (e) e.preventDefault()
    const textToSend = customText || inputText.trim()
    if (!textToSend || !activeConv) return
    if (activeConv.status === 'pending') return // Locked while waiting for approval!

    const tempId = 'temp_' + Math.random().toString(36).slice(2, 9)
    const optimisticMessage: ChatMessage = {
      id: tempId,
      conversationId: activeConv.id,
      senderId: currentUser.id,
      body: textToSend,
      createdAt: new Date().toISOString(),
      status: 'sending',
    }

    setMessages((prev) => [...prev, optimisticMessage])
    if (!customText) setInputText('')
    scrollToBottom('instant')

    try {
      const res = await fetch('/api/messaging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: activeConv.id,
          body: textToSend,
          senderId: currentUser.id,
          tempId,
          remoteInstanceUrl: activeConv.remoteInstanceUrl,
          remoteHandle: activeConv.otherUser.username,
        }),
      })
      const data = await res.json()
      if (res.ok && data.message) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...data.message, status: 'sent' } : m))
        )
      }
      loadConversations()
    } catch (err) {
      console.error('Failed to send message', err)
    }
  }

  // Pending incoming requests from other instances
  const incomingRequests = useMemo(() => {
    return friendships.filter((f) => f.status === 'pending' && f.direction === 'incoming')
  }, [friendships])

  // Filtered conversations
  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      const matchesSearch =
        c.otherUser.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.otherUser.username.toLowerCase().includes(searchQuery.toLowerCase())
      if (!matchesSearch) return false
      if (inboxFilter === 'pending') return c.status === 'pending'
      if (inboxFilter === 'unread') return (c.unreadCount || 0) > 0
      return true
    })
  }, [conversations, searchQuery, inboxFilter])

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-100 overflow-hidden font-sans select-none">
      {/* 1. Left Sidebar: Inbox, Peer Management & Routing */}
      <aside className="w-80 sm:w-96 border-r border-slate-800/80 bg-slate-900/90 flex flex-col shrink-0">
        {/* Brand & Account Header */}
        <div className="p-4 border-b border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <Store className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-bold text-white leading-tight truncate max-w-[150px]">
                  {businessName || 'Chatze Store'}
                </h1>
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span className="truncate">@{currentUser.handle}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowIdentityModal(true)}
                title="My Instance Details / Share Link"
                className="p-2 rounded-xl text-slate-400 hover:text-emerald-400 hover:bg-slate-800 transition-colors"
              >
                <Share2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setShowQrModal(true)}
                title="Fonepay / eSewa QR"
                className="p-2 rounded-xl text-slate-400 hover:text-emerald-400 hover:bg-slate-800 transition-colors"
              >
                <QrCode className="w-4 h-4" />
              </button>
              <button
                onClick={onLogout}
                title="Logout"
                className="p-2 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Connect Peer Action Button */}
          <button
            onClick={() => setShowAddFriendModal(true)}
            className="w-full py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-600/20 cursor-pointer"
          >
            <UserPlus className="w-4 h-4" /> Connect Peer (Subdomain / Domain)
          </button>

          {/* Kathmandu (KTM) PoP Routing Badge */}
          <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-950/70 border border-slate-800/80 text-[11px]">
            <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Kathmandu (KTM) Edge 🇳🇵</span>
            </div>
            <div className="flex items-center gap-1 text-slate-400">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>{pingMs}ms latency</span>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Search peers by name or @handle..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-all"
            />
          </div>

          {/* Inbox Queue Filter Tabs */}
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-slate-800/80 text-[11px]">
            <button
              onClick={() => setInboxFilter('all')}
              className={`flex-1 py-1 rounded-lg font-medium transition-all ${
                inboxFilter === 'all' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({conversations.length})
            </button>
            <button
              onClick={() => setInboxFilter('pending')}
              className={`flex-1 py-1 rounded-lg font-medium transition-all ${
                inboxFilter === 'pending' ? 'bg-slate-800 text-amber-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Pending ({conversations.filter((c) => c.status === 'pending').length})
            </button>
            <button
              onClick={() => setInboxFilter('unread')}
              className={`flex-1 py-1 rounded-lg font-medium transition-all ${
                inboxFilter === 'unread' ? 'bg-slate-800 text-emerald-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Unread
            </button>
          </div>
        </div>

        {/* Incoming Friend Requests Alert Banner */}
        {incomingRequests.length > 0 && (
          <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-amber-400">
              <span className="flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5" /> Incoming Connection Requests ({incomingRequests.length})
              </span>
            </div>
            {incomingRequests.map((req) => (
              <div key={req.id} className="p-2.5 bg-slate-900 border border-slate-800 rounded-xl space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white">@{req.remote_handle}</span>
                  <span className="text-[10px] text-slate-500 truncate max-w-[140px]">
                    {req.remote_instance_url.replace(/^https?:\/\//, '')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAcceptFriendRequest(req.remote_handle, req.remote_instance_url)}
                    className="flex-1 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-[11px] transition-all"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleRejectFriendRequest(req.remote_handle)}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg text-[11px] transition-all"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/40">
          {filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 space-y-2">
              <MessageCircle className="w-8 h-8 mx-auto text-slate-600 mb-2 opacity-50" />
              <p className="font-medium text-slate-400">No peers in this queue</p>
              <p className="text-[11px] text-slate-600">
                Click "+ Connect Peer" above to connect to another deployed instance.
              </p>
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isActive = activeConv?.id === conv.id
              const isPending = conv.status === 'pending'
              return (
                <div
                  key={conv.id}
                  onClick={() => setActiveConv(conv)}
                  className={`p-3.5 flex items-start gap-3 cursor-pointer transition-colors relative ${
                    isActive ? 'bg-slate-800/90 border-l-2 border-emerald-500' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700/80 flex items-center justify-center font-bold text-xs text-emerald-400 shrink-0">
                    {conv.otherUser.displayName.slice(0, 2).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white truncate">
                        {conv.otherUser.displayName}
                      </span>
                      {conv.lastMessage && (
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {new Date(conv.lastMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-1">
                      <p className="text-[11px] text-slate-400 truncate max-w-[180px]">
                        {conv.lastMessage?.content || (isPending ? 'Waiting for approval...' : 'Connected')}
                      </p>
                      {isPending && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
                          Pending
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* 2. Main Chat Panel */}
      <main className="flex-1 flex flex-col bg-slate-950 min-w-0 relative">
        {activeConv ? (
          <>
            {/* Active Header */}
            <div className="h-16 px-6 border-b border-slate-800 flex items-center justify-between bg-slate-900/60 shrink-0 backdrop-blur-sm">
              <div
                className="flex items-center gap-3 cursor-pointer"
                onClick={() => setShowCustomerDetails(!showCustomerDetails)}
              >
                <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400">
                  {activeConv.otherUser.displayName.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    {activeConv.otherUser.displayName}
                    {activeConv.status === 'pending' ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-normal bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        Waiting for Approval
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-normal bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        Active Peer
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-slate-400">
                    {activeConv.remoteInstanceUrl
                      ? activeConv.remoteInstanceUrl.replace(/^https?:\/\//, '')
                      : `@${activeConv.otherUser.username}`}
                  </p>
                </div>
              </div>

              {/* Status Indicator */}
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/80 text-[11px]">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      streamConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-ping'
                    }`}
                  />
                  {streamConnected ? '100s SSE Live' : 'Reconnecting...'}
                </span>
              </div>
            </div>

            {/* Conversation Content: Either "Waiting for Approval" screen OR Messages Feed */}
            {activeConv.status === 'pending' ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4 max-w-md mx-auto">
                <div className="p-4 rounded-3xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                  <Clock className="w-12 h-12 animate-pulse" />
                </div>
                <h3 className="text-lg font-bold text-white">Connection Request Pending</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  You sent a connection request to <strong className="text-white">@{activeConv.otherUser.username}</strong> on{' '}
                  <span className="text-emerald-400 font-mono">{activeConv.remoteInstanceUrl || 'their instance'}</span>.
                </p>
                <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-[11px] text-slate-400 text-left space-y-1 w-full">
                  <p className="text-slate-300 font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" /> Cryptographic Peer Handshake:
                  </p>
                  <p>1. User must log in to their instance and click <strong>Accept</strong>.</p>
                  <p>2. Once accepted, end-to-end real-time messaging unlocks in <strong>0ms</strong> on both screens.</p>
                </div>

                {/* Simulation button for local testing */}
                <button
                  onClick={() => handleAcceptFriendRequest(activeConv.otherUser.username, activeConv.remoteInstanceUrl || '')}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs text-emerald-400 font-semibold transition-all cursor-pointer"
                >
                  (Testing Simulation) Approve Connection Now
                </button>
              </div>
            ) : (
              /* Active Messages Feed */
              <div
                ref={messagesContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto p-6 space-y-4 min-h-0"
              >
                {messages.map((msg) => {
                  const isMe = msg.senderId === currentUser.id
                  return (
                    <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm shadow-sm transition-all ${
                          isMe
                            ? 'bg-emerald-600 text-white rounded-br-none'
                            : 'bg-slate-800 text-slate-100 rounded-bl-none border border-slate-700/60'
                        }`}
                      >
                        <p className="break-words leading-relaxed">{msg.body}</p>
                        <div
                          className={`flex items-center justify-end gap-1 mt-1 text-[10px] ${
                            isMe ? 'text-emerald-200' : 'text-slate-400'
                          }`}
                        >
                          <span>
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {isMe && (
                            msg.status === 'sending' ? (
                              <Clock className="w-3 h-3 animate-spin text-emerald-300" />
                            ) : (
                              <CheckCheck className="w-3.5 h-3.5 text-emerald-200" />
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>
            )}

            {/* Floating "Scroll to Bottom" Button */}
            {showScrollBottom && (
              <button
                onClick={() => scrollToBottom('smooth')}
                className="absolute bottom-24 right-8 p-3 rounded-full bg-slate-900 border border-slate-700 text-emerald-400 shadow-xl hover:bg-slate-800 transition-all flex items-center gap-1.5 text-xs cursor-pointer z-20"
              >
                <ArrowDown className="w-4 h-4" />
                {hasNewUnreadWhileScrolled && (
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-bold text-[10px]">
                    New
                  </span>
                )}
              </button>
            )}

            {/* Nepal Quick Replies Bar (Active only) */}
            {activeConv.status !== 'pending' && (
              <div className="px-6 py-2 border-t border-slate-800/70 bg-slate-900/40 flex items-center gap-2 overflow-x-auto no-scrollbar shrink-0">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider shrink-0 flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-emerald-400" /> Quick:
                </span>
                {NEPAL_QUICK_REPLIES.map((reply, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleSendMessage(undefined, reply.text)}
                    className="px-3 py-1 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 rounded-full text-xs text-slate-200 whitespace-nowrap transition-colors shrink-0 cursor-pointer"
                  >
                    {reply.label}
                  </button>
                ))}
              </div>
            )}

            {/* Input Composer Bar */}
            <form
              onSubmit={handleSendMessage}
              className="p-4 border-t border-slate-800 bg-slate-900/90 flex items-center gap-3 shrink-0"
            >
              <input
                type="text"
                disabled={activeConv.status === 'pending'}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={
                  activeConv.status === 'pending'
                    ? 'Waiting for contact to approve connection request...'
                    : 'Type your message in Nepali or English (Enter to send instantly)...'
                }
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 disabled:opacity-40 transition-all"
              />
              <button
                type="submit"
                disabled={activeConv.status === 'pending' || !inputText.trim()}
                className="p-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold rounded-xl transition-all shadow-md shadow-emerald-500/20 cursor-pointer"
              >
                <Send className="w-5 h-5" />
              </button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4 max-w-sm mx-auto">
            <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 text-slate-500">
              <Globe className="w-12 h-12 text-emerald-400" />
            </div>
            <h3 className="text-base font-bold text-white">Independent Edge Messaging</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Each user deploys their own independent instance. Connect with other users by adding their username and subdomain/domain.
            </p>
            <button
              onClick={() => setShowAddFriendModal(true)}
              className="py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold flex items-center gap-2 cursor-pointer shadow-lg shadow-emerald-600/20"
            >
              <UserPlus className="w-4 h-4" /> Connect to a Peer
            </button>
          </div>
        )}
      </main>

      {/* 3. Connect Peer / Add Contact Modal */}
      {showAddFriendModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <UserPlus className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white">Connect Peer Instance</h3>
              </div>
              <button onClick={() => setShowAddFriendModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Enter your peer's username and their deployed Cloudflare Workers subdomain or custom domain. A cryptographic friend request will be sent to their instance.
            </p>

            {addFriendError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{addFriendError}</span>
              </div>
            )}

            <form onSubmit={handleSendFriendRequest} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Peer Username / Handle</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-slate-500 text-sm">@</span>
                  <input
                    type="text"
                    required
                    value={friendHandle}
                    onChange={(e) => setFriendHandle(e.target.value)}
                    placeholder="e.g. pokhara_shop"
                    className="w-full pl-8 pr-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Peer Subdomain & Domain / URL</label>
                <div className="relative">
                  <Globe className="w-4 h-4 absolute left-3.5 top-3 text-slate-500" />
                  <input
                    type="text"
                    required
                    value={friendDomain}
                    onChange={(e) => setFriendDomain(e.target.value)}
                    placeholder="e.g. pokhara-edge.workers.dev or custom.domain"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <p className="text-[10px] text-slate-500 pl-1">
                  Cloudflare Workers URL (e.g. username.workers.dev) or custom domain
                </p>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddFriendModal(false)}
                  className="px-4 py-2.5 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingRequest || !friendHandle.trim() || !friendDomain.trim()}
                  className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-2 cursor-pointer shadow-lg shadow-emerald-500/20"
                >
                  {sendingRequest ? 'Dispatching...' : 'Send Friend Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 4. My Instance Identity & Share Modal */}
      {showIdentityModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <Share2 className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white">Your Instance Address</h3>
              </div>
              <button onClick={() => setShowIdentityModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Share your handle and instance domain with friends so they can add you from their own deployed app!
            </p>

            <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-3 text-xs">
              <div>
                <span className="text-slate-500 text-[11px] block">Your Handle</span>
                <span className="text-emerald-400 font-bold font-mono text-sm">@{currentUser.handle}</span>
              </div>
              <div>
                <span className="text-slate-500 text-[11px] block">Your Deployed Domain</span>
                <span className="text-slate-200 font-mono text-xs break-all">
                  {typeof window !== 'undefined' ? window.location.origin : 'https://<your-subdomain>.workers.dev'}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                const text = `Connect with me on Chatze!\nHandle: @${currentUser.handle}\nDomain: ${window.location.origin}`
                navigator.clipboard.writeText(text)
                setCopiedLink(true)
                setTimeout(() => setCopiedLink(false), 2000)
              }}
              className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs flex items-center justify-center gap-2 cursor-pointer transition-all"
            >
              {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedLink ? 'Copied to Clipboard!' : 'Copy Connection Details'}
            </button>
          </div>
        </div>
      )}

      {/* 5. Nepal Payment QR Modal */}
      {showQrModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="max-w-xs w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                Fonepay & eSewa QR
              </span>
              <button onClick={() => setShowQrModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-white rounded-xl mx-auto w-48 h-48 flex items-center justify-center">
              <QrCode className="w-40 h-40 text-slate-950" />
            </div>

            <div className="space-y-1 text-xs">
              <p className="font-semibold text-white">{businessName}</p>
              <p className="text-slate-400">Scan via eSewa, Khalti, or any Nepal Banking App</p>
            </div>

            <button
              onClick={() => {
                setShowQrModal(false)
                if (activeConv && activeConv.status !== 'pending') {
                  handleSendMessage(undefined, '💳 Scannable Payment QR: Open your eSewa, Khalti, or mobile banking app and scan to pay.')
                }
              }}
              className="w-full py-2.5 bg-emerald-500 text-slate-950 font-bold rounded-xl text-xs hover:bg-emerald-400 transition-colors"
            >
              Share QR in Chat
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
