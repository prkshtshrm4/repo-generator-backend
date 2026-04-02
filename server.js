import 'dotenv/config'
import express from 'express'
import session from 'express-session'
import cors from 'cors'
import axios from 'axios'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { TEMPLATE_STRUCTURES, getFilesToCreate } from './templates.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 3000
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET
const GITHUB_CALLBACK_URL =
  process.env.GITHUB_CALLBACK_URL || `http://localhost:${PORT}/auth/github/callback`
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'
const PREDICT_URL = process.env.PREDICT_URL || 'http://localhost:5000/predict'

const REPO_EVENTS_TABLE = '24303909-repo-events'
const REPO_EVENTS_REGION = 'us-east-1'

const dynamoDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REPO_EVENTS_REGION }),
)

async function logRepoCreatedToDynamo(item) {
  try {
    await dynamoDoc.send(
      new PutCommand({
        TableName: REPO_EVENTS_TABLE,
        Item: item,
      }),
    )
  } catch (err) {
    console.error('[repo-events] DynamoDB write failed', err)
  }
}

async function scanAllRepoEvents() {
  const items = []
  let exclusiveStartKey
  do {
    const out = await dynamoDoc.send(
      new ScanCommand({
        TableName: REPO_EVENTS_TABLE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )
    if (out.Items?.length) items.push(...out.Items)
    exclusiveStartKey = out.LastEvaluatedKey
  } while (exclusiveStartKey)
  return items
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const app = express()

app.set('trust proxy', 1)

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  }),
)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
)

app.use(express.static(path.join(__dirname, 'public')))

function requireAuth(req, res, next) {
  if (!req.session?.accessToken) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    return res.redirect('/admin')
  }
  next()
}

app.get('/admin', (req, res) => {
  const err = req.query.error === '1'
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin — Repo Generator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
    }
    .card {
      width: 100%;
      max-width: 360px;
      padding: 32px 28px;
      border: 1px solid #27272a;
      border-radius: 12px;
      background: #111;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.25rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    p.sub { margin: 0 0 24px; font-size: 0.875rem; color: #a1a1aa; }
    label { display: block; font-size: 0.75rem; color: #71717a; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.06em; }
    input {
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 16px;
      border: 1px solid #27272a;
      border-radius: 8px;
      background: #0a0a0a;
      color: #fafafa;
      font-size: 0.9375rem;
    }
    input:focus { outline: none; border-color: #52525b; }
    button {
      width: 100%;
      padding: 12px;
      margin-top: 8px;
      border: none;
      border-radius: 8px;
      background: #fafafa;
      color: #0a0a0a;
      font-weight: 600;
      font-size: 0.9375rem;
      cursor: pointer;
    }
    button:hover { background: #fff; }
    .err { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: rgba(239, 68, 68, 0.12); color: #fca5a5; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin login</h1>
    <p class="sub">Repo Generator dashboard</p>
    ${err ? '<p class="err">Invalid username or password.</p>' : ''}
    <form method="post" action="/admin/login" autocomplete="off">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`)
})

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {}
  if (username === 'admin' && password === 'admin') {
    req.session.isAdmin = true
    return res.redirect('/admin/dashboard')
  }
  return res.redirect('/admin?error=1')
})

app.get('/admin/logout', (req, res) => {
  delete req.session.isAdmin
  res.redirect('/admin')
})

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  let items = []
  try {
    items = await scanAllRepoEvents()
  } catch (err) {
    console.error('[admin] DynamoDB scan failed', err)
  }

  items.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))

  const total = items.length
  const rows = items
    .map((ev) => {
      const url = ev.repoUrl ? String(ev.repoUrl) : ''
      const safeUrl = escapeHtml(url)
      const link = url
        ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`
        : '—'
      const conf =
        ev.confidence != null && ev.confidence !== '' && !Number.isNaN(Number(ev.confidence))
          ? escapeHtml(String(ev.confidence))
          : '—'
      return `<tr>
  <td>${escapeHtml(ev.timestamp)}</td>
  <td>${escapeHtml(ev.userId)}</td>
  <td>${escapeHtml(ev.repoName)}</td>
  <td>${escapeHtml(ev.template)}</td>
  <td>${conf}</td>
  <td>${escapeHtml(ev.visibility)}</td>
  <td class="url">${link}</td>
</tr>`
    })
    .join('\n')

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin dashboard — Repo Generator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 20px 48px;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      min-height: 100vh;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 28px;
      max-width: 1400px;
      margin-left: auto;
      margin-right: auto;
    }
    h1 { margin: 0; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; }
    .stat {
      font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 0.875rem;
      color: #a1a1aa;
    }
    .stat strong { color: #fafafa; font-size: 1.1rem; }
    a.logout {
      color: #a1a1aa;
      text-decoration: none;
      font-size: 0.875rem;
    }
    a.logout:hover { color: #fafafa; }
    .wrap { max-width: 1400px; margin: 0 auto; overflow-x: auto; border: 1px solid #27272a; border-radius: 10px; background: #111; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 0.75rem;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid #1f1f23;
      vertical-align: top;
    }
    th {
      color: #71717a;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 0.65rem;
      background: #0c0c0c;
    }
    tr:last-child td { border-bottom: none; }
    td.url a { color: #86efac; word-break: break-all; }
    td.url a:hover { text-decoration: underline; }
    .empty { padding: 48px; text-align: center; color: #71717a; font-family: ui-sans-serif, system-ui, sans-serif; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Repo events</h1>
      <p class="stat">Total repos created: <strong>${total}</strong></p>
    </div>
    <a class="logout" href="/admin/logout">Log out</a>
  </header>
  <div class="wrap">
    ${
      total === 0
        ? '<p class="empty">No events yet (or DynamoDB scan failed — check server logs).</p>'
        : `<table>
  <thead>
    <tr>
      <th>Timestamp</th>
      <th>User</th>
      <th>Repo</th>
      <th>Template</th>
      <th>Confidence</th>
      <th>Visibility</th>
      <th>URL</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`
    }
  </div>
</body>
</html>`)
})

app.get('/auth/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).send('Missing GITHUB_CLIENT_ID')
  }
  const state = crypto.randomBytes(16).toString('hex')
  req.session.oauthState = state
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope: 'repo',
    state,
  })
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`)
})

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query
  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing code')
  }
  if (
    req.query.state &&
    req.session.oauthState &&
    req.query.state !== req.session.oauthState
  ) {
    return res.status(400).send('Invalid state')
  }
  delete req.session.oauthState

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.status(500).send('GitHub OAuth not configured')
  }

  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_CALLBACK_URL,
      }),
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    )

    const accessToken = tokenRes.data?.access_token
    if (!accessToken) {
      return res.status(400).send(tokenRes.data?.error_description || 'Token exchange failed')
    }

    const userRes = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    const u = userRes.data
    req.session.accessToken = accessToken
    req.session.user = {
      login: u.login,
      name: u.name || u.login,
      avatar_url: u.avatar_url,
    }

    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173/')
  } catch (err) {
    console.error(err.response?.data || err.message)
    res.status(500).send('OAuth failed')
  }
})

app.get('/api/me', (req, res) => {
  const u = req.session?.user
  if (!u) {
    return res.json(null)
  }
  res.json({
    login: u.login,
    name: u.name,
    avatar: u.avatar_url,
    avatar_url: u.avatar_url,
  })
})

app.post('/api/predict', async (req, res) => {
  const { projectName = '', tags = [] } = req.body || {}
  const tagList = Array.isArray(tags) ? tags : []
  const text = `${projectName} ${tagList.join(' ')}`.trim()

  try {
    const { data } = await axios.post(
      PREDICT_URL,
      { text },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60_000 },
    )
    const template = data.template ?? data.predictedTemplate
    const confidence =
      typeof data.confidence === 'number' ? data.confidence : Number(data.confidence) || 0
    if (!template) {
      return res.status(502).json({ error: 'Predict service returned no template' })
    }
    return res.json({ template, confidence })
  } catch (err) {
    console.error(err.response?.data || err.message)
    const status = err.response?.status || 502
    return res.status(status).json({
      error: 'Predict service unavailable',
      detail: err.response?.data || err.message,
    })
  }
})

function toBase64(content) {
  return Buffer.from(content, 'utf8').toString('base64')
}

app.post('/api/create-repo', requireAuth, async (req, res) => {
  const { repoName, description, template, isPrivate, confidence } = req.body || {}
  if (!repoName || typeof repoName !== 'string') {
    return res.status(400).json({ error: 'repoName is required' })
  }
  if (!template || !TEMPLATE_STRUCTURES[template]) {
    return res.status(400).json({ error: 'Invalid or missing template' })
  }

  const files = getFilesToCreate(template, repoName.trim(), description)
  if (!files?.length) {
    return res.status(400).json({ error: 'No files for template' })
  }

  const token = req.session.accessToken
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  try {
    const createRes = await axios.post(
      'https://api.github.com/user/repos',
      {
        name: repoName.trim(),
        description: description || '',
        private: Boolean(isPrivate),
        auto_init: false,
      },
      { headers: authHeaders },
    )

    const repo = createRes.data
    const owner = repo.owner.login
    const name = repo.name
    const repoUrl = repo.html_url

    await new Promise((resolve) => setTimeout(resolve, 2000))

    const repoInfo = await axios.get(`https://api.github.com/repos/${owner}/${name}`, {
      headers: authHeaders,
    })
    const branch = repoInfo.data.default_branch || 'main'

    for (let i = 0; i < files.length; i++) {
      const { path: filePath, content } = files[i]
      const body = {
        message: i === 0 ? `chore: scaffold ${template}` : `chore: add ${filePath}`,
        content: toBase64(content),
        branch,
      }

      const pathInUrl = filePath.split('/').map(encodeURIComponent).join('/')

      await axios.put(
        `https://api.github.com/repos/${owner}/${name}/contents/${pathInUrl}`,
        body,
        { headers: authHeaders },
      )
    }

    const confidenceNum =
      typeof confidence === 'number' && !Number.isNaN(confidence)
        ? confidence
        : typeof confidence === 'string' && confidence !== ''
          ? Number(confidence)
          : null
    const confidenceValue =
      confidenceNum !== null && !Number.isNaN(confidenceNum) ? confidenceNum : null

    await logRepoCreatedToDynamo({
      eventId: crypto.randomUUID(),
      userId: req.session.user?.login ?? 'unknown',
      repoName: name,
      template,
      confidence: confidenceValue,
      visibility: Boolean(isPrivate) ? 'private' : 'public',
      repoUrl,
      timestamp: new Date().toISOString(),
    })

    return res.json({
      repoUrl,
      template,
      structure: TEMPLATE_STRUCTURES[template],
    })
  } catch (err) {
    const data = err.response?.data
    console.error(data || err.message)
    const status = err.response?.status || 500
    const msg = data?.message || err.message || 'Create repo failed'
    return res.status(status).json({ error: msg, details: data })
  }
})

function destroySession(req, res) {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' })
    }
    res.clearCookie('connect.sid', { path: '/' })
    return res.json({ ok: true })
  })
}

app.get('/api/logout', destroySession)
app.post('/auth/logout', destroySession)

app.listen(PORT, () => {
  console.log(`Server http://localhost:${PORT}`)
})
