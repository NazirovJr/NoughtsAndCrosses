import axios from 'axios'
import dotenv from 'dotenv'
import express from 'express'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '64kb' }))

let botUsername = null
let updatesOffset = 0
let lastPollAt = 0

const LINK_TTL_MS = 1000 * 60 * 60 // 1 hour
const linkMap = new Map()

function cleanupLinks() {
  const now = Date.now()
  for (const [code, rec] of linkMap.entries()) {
    if (!rec || now - rec.createdAt > LINK_TTL_MS) linkMap.delete(code)
  }
}

function createLinkCode() {
  // Short & safe enough for demo; user-friendly and hard to guess.
  const raw = randomBytes(5).toString('hex').toUpperCase() // 10 chars
  return `XO${raw}`
}

async function getBotUsername(token) {
  if (botUsername) return botUsername
  const url = `https://api.telegram.org/bot${token}/getMe`
  const resp = await axios.get(url, { timeout: 8000 })
  const username = resp?.data?.result?.username
  if (typeof username === 'string' && username.length > 0) {
    botUsername = username
    return username
  }
  return null
}

function extractChatId(update) {
  return (
    update?.message?.chat?.id ??
    update?.edited_message?.chat?.id ??
    update?.channel_post?.chat?.id ??
    update?.edited_channel_post?.chat?.id ??
    null
  )
}

function extractText(update) {
  return (
    update?.message?.text ??
    update?.edited_message?.text ??
    update?.channel_post?.text ??
    update?.edited_channel_post?.text ??
    ''
  )
}

function extractStartCode(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  const m = trimmed.match(/^\/start(?:\s+(.+))?$/i)
  if (!m) return null
  const code = (m[1] || '').trim()
  if (!code) return null
  return code
}

async function pollTelegramUpdates(token) {
  const now = Date.now()
  // Throttle to avoid hammering Telegram when the UI polls status.
  if (now - lastPollAt < 1200) return
  lastPollAt = now

  cleanupLinks()

  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates`
    const resp = await axios.get(url, {
      timeout: 8000,
      params: updatesOffset ? { offset: updatesOffset, limit: 50 } : { limit: 50 },
    })

    const updates = resp?.data?.result
    if (!Array.isArray(updates) || updates.length === 0) return

    for (const upd of updates) {
      if (typeof upd?.update_id === 'number') {
        updatesOffset = Math.max(updatesOffset, upd.update_id + 1)
      }

      const chatId = extractChatId(upd)
      if (chatId === null || chatId === undefined) continue

      const text = extractText(upd)
      const code = extractStartCode(text)
      if (!code) continue

      const rec = linkMap.get(code)
      if (!rec) continue

      linkMap.set(code, { ...rec, chatId: String(chatId) })
    }
  } catch (err) {
    const status = err?.response?.status
    const data = err?.response?.data
    console.error('pollTelegramUpdates failed:', status ?? '', data ?? err?.message ?? err)
  }
}

async function resolveTelegramChatId(token) {
  // Safer default for public deployments:
  // - If you want "one admin/test chat", set TELEGRAM_CHAT_ID
  // - Otherwise, use per-player linkCode (player must press Start in bot)
  const envChatId = process.env.TELEGRAM_CHAT_ID
  return envChatId || null
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/telegram/link', async (_req, res) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return res.status(500).json({
        ok: false,
        error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN.',
      })
    }

    cleanupLinks()
    const code = createLinkCode()
    linkMap.set(code, { createdAt: Date.now(), chatId: null })

    const username = await getBotUsername(token)
    const deepLink = username ? `https://t.me/${username}?start=${code}` : null

    return res.json({ ok: true, code, deepLink })
  } catch (err) {
    console.error('Create link failed:', err?.message ?? err)
    return res.status(500).json({ ok: false, error: 'Failed to create link' })
  }
})

app.get('/api/telegram/link/:code', async (req, res) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return res.status(500).json({
        ok: false,
        error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN.',
      })
    }

    const code = String(req.params.code || '').trim()
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' })

    cleanupLinks()
    if (!linkMap.has(code)) return res.status(404).json({ ok: false, error: 'Unknown code' })

    await pollTelegramUpdates(token)

    const rec = linkMap.get(code)
    return res.json({ ok: true, linked: Boolean(rec?.chatId) })
  } catch (err) {
    console.error('Link status failed:', err?.message ?? err)
    return res.status(500).json({ ok: false, error: 'Failed to check status' })
  }
})

app.post('/api/telegram', async (req, res) => {
  try {
    const body = req.body ?? {}
    const event = body.event
    const promo = body.promo
    const linkCode = body.linkCode

    if (event !== 'win' && event !== 'loss') {
      return res.status(400).json({ ok: false, error: 'Invalid event' })
    }

    if (event === 'win') {
      if (typeof promo !== 'string' || !/^\d{5}$/.test(promo)) {
        return res.status(400).json({ ok: false, error: 'Invalid promo' })
      }
    }

    const token = process.env.TELEGRAM_BOT_TOKEN

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN.',
      })
    }

    let chatId = null

    if (typeof linkCode === 'string' && linkCode.trim()) {
      await pollTelegramUpdates(token)
      cleanupLinks()
      const rec = linkMap.get(linkCode.trim())
      if (rec?.chatId) {
        chatId = rec.chatId
      } else {
        return res.status(400).json({
          ok: false,
          error: 'Telegram is not connected for this player. Please connect the bot first.',
        })
      }
    } else {
      chatId = await resolveTelegramChatId(token)
      if (!chatId) {
        return res.status(400).json({
          ok: false,
          error:
            'Telegram is not connected. Connect Telegram in the UI (press Start in the bot) or set TELEGRAM_CHAT_ID (admin/test chat).',
        })
      }
    }

    const text =
      event === 'win' ? `Победа! Промокод выдан: ${promo}` : 'Проигрыш'

    const url = `https://api.telegram.org/bot${token}/sendMessage`
    await axios.post(
      url,
      {
        chat_id: chatId,
        text,
      },
      { timeout: 8000 },
    )

    return res.json({ ok: true })
  } catch (err) {
    console.error('Telegram send failed:', err?.message ?? err)
    return res.status(500).json({ ok: false, error: 'Failed to send message' })
  }
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const distDir = path.join(__dirname, '..', 'dist')
const indexHtml = path.join(distDir, 'index.html')

// When built, serve the SPA from the same server (single URL for deployment).
if (fs.existsSync(indexHtml)) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(indexHtml))
}

const port = Number(process.env.PORT) || 5174
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`)
})

