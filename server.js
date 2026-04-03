import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'fs'

const app = new Hono()
const ALLOWED = new Set(['channels', 'search', 'videos'])
const YT_KEY = process.env.YOUTUBE_API_KEY || ''

/* ---------- Rate-limit (simple in-memory) ---------- */
const RL = new Map()
const RL_WINDOW = 60_000   // 1 min
const RL_MAX = 60           // max requests per window per IP

function rateOk(ip) {
  const now = Date.now()
  let rec = RL.get(ip)
  if (!rec || now - rec.t > RL_WINDOW) { rec = { t: now, n: 0 }; RL.set(ip, rec) }
  rec.n++
  return rec.n <= RL_MAX
}

/* ---------- Origin check ---------- */
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin') || c.req.header('referer') || ''
  const host = c.req.header('host') || ''
  // Allow same-origin requests and known domains
  if (origin && !origin.includes(host) && !origin.includes('oldjailab.com') && !origin.includes('zeabur.app') && !origin.includes('localhost')) {
    return c.json({ error: { message: 'Forbidden' } }, 403)
  }
  await next()
})

/* ---------- YouTube API proxy ---------- */
app.get('/api/youtube/:path', async (c) => {
  const path = c.req.param('path')
  if (!ALLOWED.has(path)) return c.json({ error: { message: 'Invalid endpoint' } }, 400)
  if (!YT_KEY) return c.json({ error: { message: 'Server API key not configured' } }, 500)

  const ip = c.req.header('x-forwarded-for') || 'unknown'
  if (!rateOk(ip)) return c.json({ error: { message: 'Rate limit exceeded' } }, 429)

  // Forward query params, strip any client-sent key
  const params = new URLSearchParams(c.req.query())
  params.delete('key')
  params.set('key', YT_KEY)

  const url = `https://www.googleapis.com/youtube/v3/${path}?${params.toString()}`
  try {
    const resp = await fetch(url)
    const data = await resp.json()
    return c.json(data, resp.status)
  } catch (e) {
    return c.json({ error: { message: 'Proxy fetch failed' } }, 502)
  }
})

/* ---------- Serve static files ---------- */
app.get('/', (c) => {
  const html = readFileSync('./index.html', 'utf8')
  return c.html(html)
})

/* ---------- Start ---------- */
const port = Number(process.env.PORT || 8080)
console.log(`Server running on port ${port}`)
serve({ fetch: app.fetch, port })
