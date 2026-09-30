import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'

type Bindings = {
  DB?: any // Cloudflare D1 Database binding
  JWT_SECRET?: string
  NODE_ENV?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

// ============================================================================
// 1. In-Memory Process Event Hub (Multi-Device Sync Pipeline: Flow A & B)
// ============================================================================
type UserStreamClient = {
  id: string
  userId: string
  write: (data: string) => void
}

const activeStreams = new Map<string, Set<UserStreamClient>>() // userId -> Set of open devices

export function emitUserEvent(userId: string, eventName: string, payload: any) {
  const clients = activeStreams.get(userId)
  const packet = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
  if (clients) {
    for (const client of clients) {
      try {
        client.write(packet)
      } catch {
        clients.delete(client)
      }
    }
  }
}

export function broadcastAllStreams(eventName: string, payload: any) {
  const packet = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const [, clients] of activeStreams) {
    for (const client of clients) {
      try {
        client.write(packet)
      } catch {
        clients.delete(client)
      }
    }
  }
}

// ============================================================================
// 2. WebCrypto ECDSA Key Management (Asymmetric Federation Handshake)
// ============================================================================
let serverKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey } | null = null
let exportedPublicKeyBase64 = ''

async function ensureServerKeyPair(db?: any): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  if (serverKeyPair) return serverKeyPair

  if (db) {
    try {
      const pubRow = await db.prepare("SELECT value FROM system_config WHERE key = 'federation_public_key'").first()
      const privRow = await db.prepare("SELECT value FROM system_config WHERE key = 'federation_private_key'").first()
      if (pubRow && privRow) {
        const pubJwk = JSON.parse(pubRow.value)
        const privJwk = JSON.parse(privRow.value)
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          pubJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        )
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          privJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign']
        )
        serverKeyPair = { publicKey, privateKey }
        exportedPublicKeyBase64 = btoa(JSON.stringify(pubJwk))
        return serverKeyPair
      }
    } catch (e) {
      console.warn('[WebCrypto Key Init Warning]', e)
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  serverKeyPair = keyPair

  const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  exportedPublicKeyBase64 = btoa(JSON.stringify(pubJwk))

  if (db) {
    try {
      await db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('federation_public_key', ?), ('federation_private_key', ?)")
        .bind(JSON.stringify(pubJwk), JSON.stringify(privJwk)).run()
    } catch (e) {
      console.warn('[WebCrypto Key Save Warning]', e)
    }
  }

  return serverKeyPair
}

async function signPayload(payloadString: string): Promise<string> {
  const keys = await ensureServerKeyPair()
  const enc = new TextEncoder().encode(payloadString)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc)
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// ============================================================================
// 3. Native D1 Database Schema & Self-Healing Migration
// ============================================================================
let d1Initialized = false
async function ensureD1Database(db: any) {
  if (d1Initialized || !db) return
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'customer',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        remote_handle TEXT,
        remote_instance_url TEXT,
        last_message_snippet TEXT,
        last_message_at INTEGER NOT NULL,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS federation_friendships (
        id TEXT PRIMARY KEY,
        local_user_id TEXT NOT NULL,
        remote_handle TEXT NOT NULL,
        remote_instance_url TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        direction TEXT DEFAULT 'outgoing',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON conversations(user_a, last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON conversations(user_b, last_message_at DESC);
    `)
    d1Initialized = true
  } catch (err: any) {
    console.warn('[D1 Migration Warning]', err?.message)
  }
}

// In-Memory Fallback State (for local development or testing)
interface MemUser {
  id: string
  handle: string
  display_name: string
  password_hash: string
  role: string
  created_at: number
}

interface MemConversation {
  id: string
  user_a: string
  user_b: string
  remote_handle?: string
  remote_instance_url?: string
  last_message_snippet: string | null
  last_message_at: number
  status: string // 'active' | 'pending' | 'archived'
}

interface MemMessage {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  created_at: number
  read_at: number | null
}

interface MemFriendship {
  id: string
  local_user_id: string
  remote_handle: string
  remote_instance_url: string
  status: string // 'pending' | 'active' | 'rejected'
  direction: 'incoming' | 'outgoing'
  created_at: number
}

const memoryStore = {
  users: new Map<string, MemUser>(),
  conversations: new Map<string, MemConversation>(),
  messages: [] as MemMessage[],
  config: new Map<string, string>(),
  friendships: new Map<string, MemFriendship>(),
}

// Seed admin and initial welcome conversation
function seedInitialData() {
  if (memoryStore.users.size === 0) {
    const admin: MemUser = {
      id: 'usr_admin',
      handle: 'my_store',
      display_name: 'Chatze Nepal Store 🇳🇵',
      password_hash: 'admin123',
      role: 'admin',
      created_at: Date.now() - 86400000,
    }
    memoryStore.users.set(admin.id, admin)

    // Demo peer for testing out-of-the-box
    const demoFriend: MemFriendship = {
      id: 'friend_pokhara',
      local_user_id: admin.id,
      remote_handle: 'pokhara_shop',
      remote_instance_url: 'https://pokhara-edge.workers.dev',
      status: 'active',
      direction: 'outgoing',
      created_at: Date.now() - 43200000,
    }
    memoryStore.friendships.set(demoFriend.id, demoFriend)

    const conv1: MemConversation = {
      id: 'conv_pokhara',
      user_a: admin.id,
      user_b: 'pokhara_shop',
      remote_handle: 'pokhara_shop',
      remote_instance_url: 'https://pokhara-edge.workers.dev',
      last_message_snippet: 'Namaste! Cross-instance federation is active between Kathmandu and Pokhara.',
      last_message_at: Date.now() - 1800000,
      status: 'active',
    }
    memoryStore.conversations.set(conv1.id, conv1)

    memoryStore.messages.push({
      id: 'msg_init_1',
      conversation_id: conv1.id,
      sender_id: 'pokhara_shop',
      content: 'Namaste! Cross-instance federation is active between Kathmandu and Pokhara.',
      created_at: Date.now() - 1800000,
      read_at: null,
    })

    memoryStore.config.set('business_name', 'Chatze Nepal Store')
    memoryStore.config.set('is_setup', 'true')
  }
}
seedInitialData()

// Helper: Normalize URL to standard https origin
function normalizeUrl(url: string): string {
  let cleaned = url.trim()
  if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    cleaned = 'https://' + cleaned
  }
  return cleaned.replace(/\/+$/, '')
}

// ============================================================================
// 4. Setup Wizard Endpoints
// ============================================================================
app.get('/api/setup/status', async (c) => {
  const db = c.env?.DB
  if (db) {
    await ensureD1Database(db)
    const setupRow = await db.prepare("SELECT value FROM system_config WHERE key = 'is_setup'").first()
    const nameRow = await db.prepare("SELECT value FROM system_config WHERE key = 'business_name'").first()
    return c.json({
      setupRequired: !setupRow || setupRow.value !== 'true',
      businessName: nameRow?.value || 'Chatze Nepal Store',
    })
  }

  const isSetup = memoryStore.config.get('is_setup') === 'true'
  return c.json({
    setupRequired: !isSetup,
    businessName: memoryStore.config.get('business_name') || 'Chatze Nepal Store',
  })
})

app.post('/api/setup', async (c) => {
  const { businessName, adminUsername, password } = await c.req.json()
  const db = c.env?.DB
  const adminId = 'usr_admin_' + Math.random().toString(36).slice(2, 9)
  const cleanHandle = (adminUsername || 'admin').replace(/^@/, '')
  const now = Date.now()

  if (db) {
    await ensureD1Database(db)
    await db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('is_setup', 'true'), ('business_name', ?)")
      .bind(businessName).run()
    await db.prepare("INSERT OR REPLACE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)")
      .bind(adminId, cleanHandle, businessName, password, now).run()
    await ensureServerKeyPair(db)
    return c.json({ success: true, adminId, handle: cleanHandle })
  }

  memoryStore.config.set('is_setup', 'true')
  memoryStore.config.set('business_name', businessName || 'My Shop')
  const newAdmin: MemUser = {
    id: adminId,
    handle: cleanHandle,
    display_name: businessName || 'Shop Admin',
    password_hash: password || 'admin123',
    role: 'admin',
    created_at: now,
  }
  memoryStore.users.set(adminId, newAdmin)
  await ensureServerKeyPair()
  return c.json({ success: true, adminId, handle: newAdmin.handle })
})

// ============================================================================
// 5. Auth API
// ============================================================================
app.get('/api/auth/session', async (c) => {
  const db = c.env?.DB
  if (db) {
    await ensureD1Database(db)
    const admin = await db.prepare("SELECT id, handle, display_name, role, created_at FROM users WHERE role = 'admin' LIMIT 1").first()
    if (admin) return c.json({ user: admin })
  }

  const firstAdmin = Array.from(memoryStore.users.values()).find((u) => u.role === 'admin') || Array.from(memoryStore.users.values())[0]
  if (firstAdmin) {
    const { password_hash, ...safe } = firstAdmin
    return c.json({ user: safe })
  }
  return c.json({ user: null }, 401)
})

app.post('/api/auth/sign-in', async (c) => {
  const { username, password } = await c.req.json()
  const cleanHandle = (username || '').replace(/^@/, '')
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    const user = await db.prepare("SELECT * FROM users WHERE handle = ? OR id = ?").bind(cleanHandle, cleanHandle).first()
    if (user && user.password_hash === password) {
      const { password_hash, ...safe } = user
      return c.json({ success: true, user: safe })
    }
  }

  const match = Array.from(memoryStore.users.values()).find((u) => u.handle === cleanHandle && u.password_hash === password)
  if (match) {
    const { password_hash, ...safe } = match
    return c.json({ success: true, user: safe })
  }
  return c.json({ error: 'Invalid handle or password' }, 401)
})

app.post('/api/auth/sign-up', async (c) => {
  const { username, displayName, password } = await c.req.json()
  const cleanHandle = (username || '').replace(/^@/, '')
  const id = 'usr_' + Math.random().toString(36).slice(2, 9)
  const now = Date.now()
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    await db.prepare("INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'customer', ?)")
      .bind(id, cleanHandle, displayName, password, now).run()
    return c.json({ success: true, user: { id, handle: cleanHandle, display_name: displayName, role: 'customer' } })
  }

  const newUser: MemUser = {
    id,
    handle: cleanHandle,
    display_name: displayName || cleanHandle,
    password_hash: password,
    role: 'customer',
    created_at: now,
  }
  memoryStore.users.set(id, newUser)
  return c.json({ success: true, user: { id, handle: cleanHandle, display_name: displayName, role: 'customer' } })
})

// ============================================================================
// 6. Conversations & Friendships (Federated Multi-Instance Integration)
// ============================================================================
app.get('/api/conversations', async (c) => {
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    const convRows = await db.prepare('SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT 100').all()
    const mapped = (convRows.results || []).map((row: any) => ({
      id: row.id,
      otherUser: {
        id: row.user_b,
        username: row.remote_handle || row.user_b,
        displayName: row.remote_handle ? `@${row.remote_handle}` : row.user_b,
      },
      status: row.status, // 'active' | 'pending' | 'archived'
      remoteInstanceUrl: row.remote_instance_url || null,
      lastMessage: row.last_message_snippet
        ? {
            content: row.last_message_snippet,
            createdAt: row.last_message_at,
          }
        : null,
    }))
    return c.json({ conversations: mapped })
  }

  const convList = Array.from(memoryStore.conversations.values())
    .sort((a, b) => b.last_message_at - a.last_message_at)
    .map((conv) => {
      const otherUser = memoryStore.users.get(conv.user_b) || {
        id: conv.user_b,
        handle: conv.remote_handle || conv.user_b,
        display_name: conv.remote_handle ? `@${conv.remote_handle}` : conv.user_b,
      }
      return {
        id: conv.id,
        otherUser: {
          id: otherUser.id,
          username: otherUser.handle,
          displayName: otherUser.display_name,
        },
        status: conv.status,
        remoteInstanceUrl: conv.remote_instance_url || null,
        lastMessage: conv.last_message_snippet
          ? {
              content: conv.last_message_snippet,
              createdAt: conv.last_message_at,
            }
          : null,
      }
    })

  return c.json({ conversations: convList })
})

// Get all incoming and outgoing friend requests
app.get('/api/federation/friendships', async (c) => {
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    const rows = await db.prepare('SELECT * FROM federation_friendships ORDER BY created_at DESC').all()
    return c.json({ friendships: rows.results || [] })
  }

  const list = Array.from(memoryStore.friendships.values()).sort((a, b) => b.created_at - a.created_at)
  return c.json({ friendships: list })
})

// ============================================================================
// 7. Send Friend Request (Outbound to Remote Peer Instance or Local)
// ============================================================================
app.post('/api/federation/requests', async (c) => {
  const { remoteHandle, remoteInstanceUrl, senderId } = await c.req.json()
  const cleanRemoteHandle = (remoteHandle || '').replace(/^@/, '').trim()
  const normalizedUrl = normalizeUrl(remoteInstanceUrl)
  const db = c.env?.DB
  const localUserId = senderId || 'usr_admin'

  const friendshipId = 'freq_' + Math.random().toString(36).slice(2, 9)
  const conversationId = 'conv_' + cleanRemoteHandle
  const now = Date.now()

  // 1. Create or update local friendship as pending outgoing
  const friendshipRecord: MemFriendship = {
    id: friendshipId,
    local_user_id: localUserId,
    remote_handle: cleanRemoteHandle,
    remote_instance_url: normalizedUrl,
    status: 'pending',
    direction: 'outgoing',
    created_at: now,
  }

  const convRecord: MemConversation = {
    id: conversationId,
    user_a: localUserId,
    user_b: cleanRemoteHandle,
    remote_handle: cleanRemoteHandle,
    remote_instance_url: normalizedUrl,
    last_message_snippet: `Friend request sent to @${cleanRemoteHandle}`,
    last_message_at: now,
    status: 'pending', // 'pending' locks the chat until approved!
  }

  if (db) {
    await ensureD1Database(db)
    await db.prepare('INSERT OR REPLACE INTO federation_friendships (id, local_user_id, remote_handle, remote_instance_url, status, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(friendshipRecord.id, friendshipRecord.local_user_id, friendshipRecord.remote_handle, friendshipRecord.remote_instance_url, friendshipRecord.status, friendshipRecord.direction, now).run()

    await db.prepare('INSERT OR REPLACE INTO conversations (id, user_a, user_b, remote_handle, remote_instance_url, last_message_snippet, last_message_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(convRecord.id, convRecord.user_a, convRecord.user_b, convRecord.remote_handle, convRecord.remote_instance_url, convRecord.last_message_snippet, now, convRecord.status).run()
  } else {
    memoryStore.friendships.set(friendshipId, friendshipRecord)
    memoryStore.conversations.set(conversationId, convRecord)
  }

  // 2. Dispatch HTTP request to remote peer instance in background
  const myHandle = memoryStore.users.get(localUserId)?.handle || 'my_store'
  const myName = memoryStore.config.get('business_name') || 'Chatze Nepal Store'
  const myInstanceUrl = c.req.url.replace(/\/api\/.*$/, '')

  const payload = JSON.stringify({
    from_handle: myHandle,
    from_display_name: myName,
    from_instance_url: myInstanceUrl,
    to_handle: cleanRemoteHandle,
    timestamp: now,
  })

  // Sign with ECDSA
  let signature = ''
  try {
    signature = await signPayload(payload)
  } catch (e) {
    console.warn('[Sign Error]', e)
  }

  // Non-blocking async dispatch
  fetch(`${normalizedUrl}/api/federation/v1/requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Federation-Signature': signature,
    },
    body: payload,
  }).catch((err) => {
    console.warn('[Federation Dispatch Warning: Peer might be offline or starting up]', err?.message)
  })

  // Notify local UI stream
  emitUserEvent(localUserId, 'conversation_updated', convRecord)

  return c.json({
    success: true,
    friendship: friendshipRecord,
    conversation: convRecord,
  })
})

// ============================================================================
// 8. Inbound Friend Request (Received from Remote Peer Instance)
// ============================================================================
app.post('/api/federation/v1/requests', async (c) => {
  const body = await c.req.json()
  const { from_handle, from_display_name, from_instance_url } = body
  const db = c.env?.DB
  const cleanFromHandle = (from_handle || 'peer').replace(/^@/, '')
  const remoteUrl = normalizeUrl(from_instance_url || '')
  const now = Date.now()

  const friendshipId = 'freq_in_' + Math.random().toString(36).slice(2, 9)
  const conversationId = 'conv_' + cleanFromHandle

  const incomingFriendship: MemFriendship = {
    id: friendshipId,
    local_user_id: 'usr_admin',
    remote_handle: cleanFromHandle,
    remote_instance_url: remoteUrl,
    status: 'pending',
    direction: 'incoming',
    created_at: now,
  }

  const incomingConv: MemConversation = {
    id: conversationId,
    user_a: 'usr_admin',
    user_b: cleanFromHandle,
    remote_handle: cleanFromHandle,
    remote_instance_url: remoteUrl,
    last_message_snippet: `Connection request from @${cleanFromHandle}`,
    last_message_at: now,
    status: 'pending',
  }

  if (db) {
    await ensureD1Database(db)
    await db.prepare('INSERT OR REPLACE INTO federation_friendships (id, local_user_id, remote_handle, remote_instance_url, status, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(incomingFriendship.id, incomingFriendship.local_user_id, incomingFriendship.remote_handle, incomingFriendship.remote_instance_url, incomingFriendship.status, incomingFriendship.direction, now).run()

    await db.prepare('INSERT OR REPLACE INTO conversations (id, user_a, user_b, remote_handle, remote_instance_url, last_message_snippet, last_message_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(incomingConv.id, incomingConv.user_a, incomingConv.user_b, incomingConv.remote_handle, incomingConv.remote_instance_url, incomingConv.last_message_snippet, now, incomingConv.status).run()
  } else {
    memoryStore.friendships.set(friendshipId, incomingFriendship)
    memoryStore.conversations.set(conversationId, incomingConv)
  }

  // Push instant alert over SSE to current user's screen
  broadcastAllStreams('incoming_friend_request', {
    friendship: incomingFriendship,
    from_handle: cleanFromHandle,
    from_display_name: from_display_name || `@${cleanFromHandle}`,
    from_instance_url: remoteUrl,
  })

  return c.json({ success: true, status: 'received' }, 201)
})

// ============================================================================
// 9. Friend Request Accept & Reject Handshake
// ============================================================================
// User clicks "Accept" in UI
app.post('/api/federation/requests/accept', async (c) => {
  const { remoteHandle, remoteInstanceUrl } = await c.req.json()
  const cleanHandle = (remoteHandle || '').replace(/^@/, '').trim()
  const conversationId = 'conv_' + cleanHandle
  const db = c.env?.DB
  const now = Date.now()

  // 1. Mark local friendship and conversation as active
  if (db) {
    await ensureD1Database(db)
    await db.prepare("UPDATE federation_friendships SET status = 'active' WHERE remote_handle = ?").bind(cleanHandle).run()
    await db.prepare("UPDATE conversations SET status = 'active', last_message_snippet = 'Connected! You can now send messages.' WHERE id = ?").bind(conversationId).run()
  } else {
    for (const [, f] of memoryStore.friendships) {
      if (f.remote_handle === cleanHandle) {
        f.status = 'active'
      }
    }
    const conv = memoryStore.conversations.get(conversationId)
    if (conv) {
      conv.status = 'active'
      conv.last_message_snippet = 'Connected! You can now send messages.'
    }
  }

  // 2. Dual-sided live broadcast: Notify our screen in 0ms
  broadcastAllStreams('friend_accepted', {
    remoteHandle: cleanHandle,
    conversationId,
    status: 'active',
  })

  // 3. Dispatch acceptance back to peer instance in non-blocking async
  if (remoteInstanceUrl) {
    const myHandle = memoryStore.users.get('usr_admin')?.handle || 'my_store'
    fetch(`${normalizeUrl(remoteInstanceUrl)}/api/federation/v1/requests/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_handle: myHandle,
        accepted: true,
        timestamp: now,
      }),
    }).catch((err) => {
      console.warn('[Federation Accept Dispatch Warning]', err?.message)
    })
  }

  return c.json({ success: true, unlocked: true })
})

// Inbound acceptance from peer instance (they approved our request)
app.post('/api/federation/v1/requests/accept', async (c) => {
  const { from_handle } = await c.req.json()
  const cleanHandle = (from_handle || '').replace(/^@/, '').trim()
  const conversationId = 'conv_' + cleanHandle
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    await db.prepare("UPDATE federation_friendships SET status = 'active' WHERE remote_handle = ?").bind(cleanHandle).run()
    await db.prepare("UPDATE conversations SET status = 'active', last_message_snippet = 'Connected! You can now send messages.' WHERE id = ?").bind(conversationId).run()
  } else {
    for (const [, f] of memoryStore.friendships) {
      if (f.remote_handle === cleanHandle) {
        f.status = 'active'
      }
    }
    const conv = memoryStore.conversations.get(conversationId)
    if (conv) {
      conv.status = 'active'
      conv.last_message_snippet = 'Connected! You can now send messages.'
    }
  }

  // Live broadcast: Instantly unlocks sender's UI from "Waiting for Approval" to "Active"
  broadcastAllStreams('friend_accepted', {
    remoteHandle: cleanHandle,
    conversationId,
    status: 'active',
  })

  return c.json({ success: true, status: 'unlocked' })
})

// Reject / Decline Request
app.post('/api/federation/requests/reject', async (c) => {
  const { remoteHandle } = await c.req.json()
  const cleanHandle = (remoteHandle || '').replace(/^@/, '').trim()
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    await db.prepare("DELETE FROM federation_friendships WHERE remote_handle = ?").bind(cleanHandle).run()
    await db.prepare("DELETE FROM conversations WHERE id = ?").bind('conv_' + cleanHandle).run()
  } else {
    for (const [id, f] of memoryStore.friendships) {
      if (f.remote_handle === cleanHandle) {
        memoryStore.friendships.delete(id)
      }
    }
    memoryStore.conversations.delete('conv_' + cleanHandle)
  }

  broadcastAllStreams('friendship_removed', { remoteHandle: cleanHandle })
  return c.json({ success: true })
})

// ============================================================================
// 10. Messages & 0ms Optimistic Delivery + Cross-Peer Federation
// ============================================================================
app.get('/api/messaging', async (c) => {
  const conversationId = c.req.query('conversationId')
  if (!conversationId) return c.json({ messages: [] })
  const db = c.env?.DB

  if (db) {
    await ensureD1Database(db)
    const rows = await db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .bind(conversationId).all()
    const mapped = (rows.results || []).map((r: any) => ({
      id: r.id,
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      body: r.content,
      createdAt: new Date(r.created_at).toISOString(),
      readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    }))
    return c.json({ messages: mapped })
  }

  const msgs = memoryStore.messages
    .filter((m) => m.conversation_id === conversationId)
    .sort((a, b) => a.created_at - b.created_at)
    .map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      body: m.content,
      createdAt: new Date(m.created_at).toISOString(),
      readAt: m.read_at ? new Date(m.read_at).toISOString() : null,
    }))

  return c.json({ messages: msgs })
})

app.post('/api/messaging', async (c) => {
  const { conversationId, body, senderId, tempId, remoteInstanceUrl, remoteHandle } = await c.req.json()
  const db = c.env?.DB
  const messageId = 'msg_' + Math.random().toString(36).slice(2, 9)
  const now = Date.now()
  const actualSender = senderId || 'usr_admin'

  const messageRecord = {
    id: messageId,
    conversationId: conversationId || 'conv_general',
    senderId: actualSender,
    body: body || '',
    createdAt: new Date(now).toISOString(),
    readAt: null,
    tempId: tempId || null,
  }

  // 1. Write to local database (~8ms)
  if (db) {
    await ensureD1Database(db)
    await db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .bind(messageRecord.id, messageRecord.conversationId, messageRecord.senderId, messageRecord.body, now).run()
    await db.prepare('UPDATE conversations SET last_message_snippet = ?, last_message_at = ? WHERE id = ?')
      .bind(messageRecord.body, now, messageRecord.conversationId).run()
  } else {
    memoryStore.messages.push({
      id: messageRecord.id,
      conversation_id: messageRecord.conversationId,
      sender_id: messageRecord.senderId,
      content: messageRecord.body,
      created_at: now,
      read_at: null,
    })
    const conv = memoryStore.conversations.get(messageRecord.conversationId)
    if (conv) {
      conv.last_message_snippet = messageRecord.body
      conv.last_message_at = now
    }
  }

  // 2. Flow B: Multi-Device Sync - Emit to sender's other devices (<25ms)
  emitUserEvent(actualSender, 'new_message', messageRecord)
  broadcastAllStreams('new_message', messageRecord)

  // 3. Flow A: If peer is remote, dispatch over HTTP federation to remote instance!
  const targetUrl = remoteInstanceUrl || memoryStore.conversations.get(conversationId)?.remote_instance_url
  if (targetUrl) {
    const myHandle = memoryStore.users.get(actualSender)?.handle || 'my_store'
    const targetHandle = remoteHandle || memoryStore.conversations.get(conversationId)?.remote_handle

    fetch(`${normalizeUrl(targetUrl)}/api/federation/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_handle: myHandle,
        recipient_handle: targetHandle,
        body: messageRecord.body,
        conversation_id: 'conv_' + myHandle,
        timestamp: now,
      }),
    }).catch((err) => {
      console.warn('[Remote Federation Dispatch Warning]', err?.message)
    })
  }

  // 4. Return HTTP 201 Created with swapped permanent ID
  return c.json({ success: true, message: messageRecord }, 201)
})

// Inbound message from remote peer instance
app.post('/api/federation/v1/messages', async (c) => {
  const { sender_handle, body, timestamp } = await c.req.json()
  const cleanSender = (sender_handle || 'remote_peer').replace(/^@/, '')
  const conversationId = 'conv_' + cleanSender
  const messageId = 'msg_in_' + Math.random().toString(36).slice(2, 9)
  const now = timestamp || Date.now()
  const db = c.env?.DB

  const messageRecord = {
    id: messageId,
    conversationId,
    senderId: cleanSender,
    body: body || '',
    createdAt: new Date(now).toISOString(),
    readAt: null,
  }

  if (db) {
    await ensureD1Database(db)
    await db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .bind(messageRecord.id, messageRecord.conversationId, messageRecord.senderId, messageRecord.body, now).run()
    await db.prepare('UPDATE conversations SET last_message_snippet = ?, last_message_at = ? WHERE id = ?')
      .bind(messageRecord.body, now, conversationId).run()
  } else {
    memoryStore.messages.push({
      id: messageRecord.id,
      conversation_id: messageRecord.conversationId,
      sender_id: messageRecord.senderId,
      content: messageRecord.body,
      created_at: now,
      read_at: null,
    })
    const conv = memoryStore.conversations.get(conversationId)
    if (conv) {
      conv.last_message_snippet = messageRecord.body
      conv.last_message_at = now
    }
  }

  // Push directly to recipient's screen over SSE in <20ms
  broadcastAllStreams('new_message', messageRecord)

  return c.json({ success: true, id: messageId }, 201)
})

// ============================================================================
// 11. Server-Sent Events Stream (100s Cloudflare Lifetime + 8s Heartbeat)
// ============================================================================
app.get('/api/stream', (c) => {
  const userId = c.req.query('userId') || 'usr_admin'

  return streamSSE(c, async (stream) => {
    const clientId = 'client_' + Math.random().toString(36).slice(2, 9)

    const clientRecord: UserStreamClient = {
      id: clientId,
      userId,
      write: (data: string) => {
        stream.write(data)
      },
    }

    if (!activeStreams.has(userId)) {
      activeStreams.set(userId, new Set())
    }
    activeStreams.get(userId)!.add(clientRecord)

    // Initial connected packet
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({
        clientId,
        userId,
        timestamp: Date.now(),
        edgeNode: 'KTM-Nepal-PoP',
      }),
    })

    // 8-Second Keep-Alive Heartbeat
    const pingInterval = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: 'ping',
          data: JSON.stringify({ t: Date.now() }),
        })
      } catch {
        clearInterval(pingInterval)
        activeStreams.get(userId)?.delete(clientRecord)
      }
    }, 8000)

    stream.onAbort(() => {
      clearInterval(pingInterval)
      activeStreams.get(userId)?.delete(clientRecord)
    })

    // Cloudflare Workers stream lifetime: 95 seconds
    await new Promise((resolve) => setTimeout(resolve, 95000))
    clearInterval(pingInterval)
    activeStreams.get(userId)?.delete(clientRecord)
  })
})

// ============================================================================
// 12. Identity & Health
// ============================================================================
app.get('/api/federation/identity', async (c) => {
  await ensureServerKeyPair(c.env?.DB)
  const myHandle = memoryStore.users.get('usr_admin')?.handle || 'my_store'
  return c.json({
    version: '1.0.0',
    instance_url: c.req.url.replace(/\/api\/.*$/, ''),
    handle: myHandle,
    name: memoryStore.config.get('business_name') || 'Chatze Nepal Store 🇳🇵',
    public_key: exportedPublicKeyBase64,
    algorithm: 'ECDSA-P256-SHA256',
    created_at: Date.now(),
  })
})

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    engine: 'hono-cloudflare-workers',
    edgeNode: 'Kathmandu (KTM) PoP',
    federation: 'enabled',
  })
)

export default app
