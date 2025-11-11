#!/usr/bin/env node

const express = require('express')
const cors = require('cors')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = process.env.PORT || 3000

const app = express()
app.use(cors())
app.use(express.json())

let claudeProcess = null
const activeConversations = new Map()

function checkClaudeAuth() {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json')

    if (!fs.existsSync(credentialsPath)) {
      return {
        authenticated: false,
        error: 'Claude CLI not logged in. Run: npx @anthropic-ai/claude-code login'
      }
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

    if (!credentials.claudeAiOauth) {
      return {
        authenticated: false,
        error: 'No Claude OAuth credentials found'
      }
    }

    const { expiresAt, subscriptionType } = credentials.claudeAiOauth
    const isExpired = new Date(expiresAt) < new Date()

    if (isExpired) {
      return {
        authenticated: false,
        error: `Claude credentials expired at: ${expiresAt}`
      }
    }

    return {
      authenticated: true,
      subscriptionType,
      expiresAt
    }
  } catch (error) {
    return {
      authenticated: false,
      error: `Failed to check Claude credentials: ${error.message}`
    }
  }
}

function spawnClaude() {
  if (claudeProcess) {
    console.log('Claude CLI already running')
    return
  }

  console.log('Spawning Claude CLI process...')
  claudeProcess = spawn('npx', ['@anthropic-ai/claude-code', '--json'], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  claudeProcess.stdout.on('data', (data) => {
    try {
      const lines = data.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        const event = JSON.parse(line)
        console.log('Claude event:', event.type)

        const convId = event.conversationId
        if (convId && activeConversations.has(convId)) {
          const res = activeConversations.get(convId)
          res.write(`data: ${JSON.stringify(event)}\n\n`)

          if (event.type === 'done' || event.type === 'error') {
            res.end()
            activeConversations.delete(convId)
          }
        }
      }
    } catch (err) {
      console.error('Failed to parse Claude output:', err.message)
    }
  })

  claudeProcess.stderr.on('data', (data) => {
    console.error('Claude CLI error:', data.toString())
  })

  claudeProcess.on('exit', (code) => {
    console.log(`Claude CLI exited with code ${code}`)
    claudeProcess = null
    activeConversations.forEach((res) => res.end())
    activeConversations.clear()
  })
}

app.get('/health', (req, res) => {
  const authStatus = checkClaudeAuth()
  res.json({
    ok: true,
    authenticated: authStatus.authenticated,
    claudeProcess: claudeProcess ? 'running' : 'not started',
    ...authStatus
  })
})

app.get('/auth/status', (req, res) => {
  const authStatus = checkClaudeAuth()
  res.json(authStatus)
})

app.post('/conversations', (req, res) => {
  if (!claudeProcess) {
    spawnClaude()
  }

  const { session_id, cwd, context, permissionMode } = req.body

  const conversationId = session_id || `conv_${Date.now()}`

  claudeProcess.stdin.write(JSON.stringify({
    type: 'create_conversation',
    conversationId,
    cwd: cwd || process.cwd(),
    context,
    permissionMode: permissionMode || 'ask'
  }) + '\n')

  res.json({
    success: true,
    conversationId
  })
})

app.post('/conversations/:id/messages', (req, res) => {
  const { id } = req.params
  const { content, files } = req.body

  if (!claudeProcess) {
    return res.status(400).json({
      error: 'Claude CLI not started'
    })
  }

  claudeProcess.stdin.write(JSON.stringify({
    type: 'send_message',
    conversationId: id,
    content,
    files
  }) + '\n')

  res.json({
    success: true
  })
})

app.get('/conversations/:id/stream', (req, res) => {
  const { id } = req.params

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  activeConversations.set(id, res)

  req.on('close', () => {
    activeConversations.delete(id)
  })
})

app.post('/conversations/:id/approve', (req, res) => {
  const { id } = req.params
  const { requestId, data } = req.body

  if (!claudeProcess) {
    return res.status(400).json({
      error: 'Claude CLI not started'
    })
  }

  claudeProcess.stdin.write(JSON.stringify({
    type: 'approve_tool',
    conversationId: id,
    requestId,
    data
  }) + '\n')

  res.json({
    success: true
  })
})

app.post('/conversations/:id/deny', (req, res) => {
  const { id } = req.params
  const { requestId, reason } = req.body

  if (!claudeProcess) {
    return res.status(400).json({
      error: 'Claude CLI not started'
    })
  }

  claudeProcess.stdin.write(JSON.stringify({
    type: 'deny_tool',
    conversationId: id,
    requestId,
    reason
  }) + '\n')

  res.json({
    success: true
  })
})

const server = app.listen(PORT, () => {
  console.log(`\n✅ ABsmartly Claude Code Bridge running on http://localhost:${PORT}`)
  console.log(`\nAuth Status:`)
  const authStatus = checkClaudeAuth()
  if (authStatus.authenticated) {
    console.log(`✓ Authenticated (${authStatus.subscriptionType} subscription)`)
  } else {
    console.log(`✗ Not authenticated`)
    console.log(`  ${authStatus.error}`)
    console.log(`\n  Run: npx @anthropic-ai/claude-code login`)
  }
  console.log(`\nEndpoints:`)
  console.log(`  GET  /health`)
  console.log(`  GET  /auth/status`)
  console.log(`  POST /conversations`)
  console.log(`  POST /conversations/:id/messages`)
  console.log(`  GET  /conversations/:id/stream`)
  console.log(`  POST /conversations/:id/approve`)
  console.log(`  POST /conversations/:id/deny`)
  console.log(`\nReady for connections from ABsmartly extension 🚀\n`)
})

process.on('SIGTERM', () => {
  console.log('\nShutting down...')
  if (claudeProcess) {
    claudeProcess.kill()
  }
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('\nShutting down...')
  if (claudeProcess) {
    claudeProcess.kill()
  }
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
