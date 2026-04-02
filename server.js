import 'dotenv/config'
import express from 'express'
import session from 'express-session'
import cors from 'cors'
import axios from 'axios'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { TEMPLATE_STRUCTURES, getFilesToCreate } from './templates.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 3000
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET
const GITHUB_CALLBACK_URL =
  process.env.GITHUB_CALLBACK_URL || `http://localhost:${PORT}/auth/github/callback`
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'
const PREDICT_URL = process.env.PREDICT_URL || 'http://localhost:5000/predict'

const app = express()

app.set('trust proxy', 1)

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  }),
)

app.use(express.json())

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
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
  const { code, state } = req.query
  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing code')
  }
  if (!state || state !== req.session.oauthState) {
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
  const { projectName = '', description = '', tags = [] } = req.body || {}
  const tagList = Array.isArray(tags) ? tags : []
  const text = [projectName, description, tagList.join(' ')].filter(Boolean).join(' ')

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
  const { repoName, description, template, isPrivate } = req.body || {}
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

    let branch = null

    for (let i = 0; i < files.length; i++) {
      const { path: filePath, content } = files[i]
      const body = {
        message: i === 0 ? `chore: scaffold ${template}` : `chore: add ${filePath}`,
        content: toBase64(content),
      }
      if (branch) {
        body.branch = branch
      }

      const pathInUrl = filePath.split('/').map(encodeURIComponent).join('/')

      await axios.put(
        `https://api.github.com/repos/${owner}/${name}/contents/${pathInUrl}`,
        body,
        { headers: authHeaders },
      )

      if (!branch) {
        const info = await axios.get(`https://api.github.com/repos/${owner}/${name}`, {
          headers: authHeaders,
        })
        branch = info.data.default_branch || 'main'
      }
    }

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
