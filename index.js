#!/usr/bin/env node

const express = require('express')
const cors = require('cors')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PREFERRED_PORTS = [3000, 3001, 3002, 3003, 3004]
const PORT = process.env.PORT ? parseInt(process.env.PORT) : null

const app = express()
app.use(cors())
app.use(express.json())

const claudeProcesses = new Map()
const activeStreams = new Map()
const conversationMessages = new Map()
const sessionTracking = new Map()

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

function spawnClaudeForConversation(conversationId, systemPrompt, sessionId, isResume = false) {
  if (claudeProcesses.has(conversationId)) {
    console.log(`Claude CLI already running for conversation ${conversationId}`)
    return claudeProcesses.get(conversationId)
  }

  console.log(`Spawning Claude CLI process for conversation ${conversationId}...`)
  const args = [
    '@anthropic-ai/claude-code',
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--replay-user-messages',
    '--dangerously-skip-permissions'
  ]

  if (sessionId) {
    if (isResume) {
      console.log(`Resuming session ${sessionId} for conversation ${conversationId}`)
      args.push('--resume', sessionId)
    } else {
      console.log(`Starting new session ${sessionId} for conversation ${conversationId}`)
      args.push('--session-id', sessionId)
    }
  }

  if (systemPrompt) {
    console.log(`Using custom system prompt for conversation ${conversationId}`)
    args.push('--system-prompt', systemPrompt)
  }

  const claudeProcess = spawn('npx', args, {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  claudeProcess.stdout.on('data', (data) => {
    try {
      const lines = data.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        const event = JSON.parse(line)
        console.log(`[${conversationId}] Claude event:`, JSON.stringify(event).substring(0, 300))

        const res = activeStreams.get(conversationId)
        if (res) {
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                res.write(`data: ${JSON.stringify({ type: 'text', data: block.text })}\n\n`)
              }
            }
          } else if (event.type === 'result') {
            if (event.result) {
              res.write(`data: ${JSON.stringify({ type: 'text', data: event.result })}\n\n`)
            }
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
            res.end()
            activeStreams.delete(conversationId)
          } else if (event.type === 'error') {
            res.write(`data: ${JSON.stringify({ type: 'error', data: event.error || 'Unknown error' })}\n\n`)
            res.end()
            activeStreams.delete(conversationId)
          } else {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          }
        }
      }
    } catch (err) {
      console.error(`[${conversationId}] Failed to parse Claude output:`, err.message, 'Raw:', data.toString().substring(0, 200))
    }
  })

  claudeProcess.stderr.on('data', (data) => {
    console.error(`[${conversationId}] Claude CLI stderr:`, data.toString())
  })

  claudeProcess.on('exit', (code) => {
    console.log(`[${conversationId}] Claude CLI exited with code ${code}`)
    claudeProcesses.delete(conversationId)
    const res = activeStreams.get(conversationId)
    if (res) {
      res.end()
      activeStreams.delete(conversationId)
    }
  })

  claudeProcesses.set(conversationId, claudeProcess)
  return claudeProcess
}

app.get('/health', (req, res) => {
  const authStatus = checkClaudeAuth()
  res.json({
    ok: true,
    authenticated: authStatus.authenticated,
    claudeProcesses: claudeProcesses.size,
    ...authStatus
  })
})

app.get('/auth/status', (req, res) => {
  const authStatus = checkClaudeAuth()
  res.json(authStatus)
})

app.post('/conversations', (req, res) => {
  const { session_id } = req.body
  const conversationId = session_id || `conv_${Date.now()}`

  conversationMessages.set(conversationId, [])

  if (session_id) {
    const isResume = sessionTracking.has(session_id)
    sessionTracking.set(session_id, { conversationId, isResume })
    console.log(`Conversation ${conversationId} ${isResume ? 'resuming' : 'starting'} session ${session_id}`)
  }

  res.json({
    success: true,
    conversationId
  })
})

app.post('/conversations/:id/messages', (req, res) => {
  const { id } = req.params
  const { content, files, systemPrompt } = req.body

  if (!claudeProcesses.has(id)) {
    let sessionId = null
    let isResume = false

    for (const [sid, info] of sessionTracking.entries()) {
      if (info.conversationId === id) {
        sessionId = sid
        isResume = info.isResume
        break
      }
    }

    spawnClaudeForConversation(id, systemPrompt, sessionId, isResume)
    setTimeout(() => {
      sendUserMessage(id, content, files)
    }, 1000)
  } else {
    sendUserMessage(id, content, files)
  }

  res.json({
    success: true
  })
})

function sendUserMessage(conversationId, content, files) {
  const claudeProcess = claudeProcesses.get(conversationId)
  if (!claudeProcess) {
    console.error(`[${conversationId}] No Claude process found`)
    return
  }

  const messages = conversationMessages.get(conversationId) || []
  messages.push({ role: 'user', content })
  conversationMessages.set(conversationId, messages)

  let messageContent

  if (files && files.length > 0) {
    messageContent = [{ type: 'text', text: content }]

    for (const file of files) {
      const match = file.match(/^data:image\/(\w+);base64,(.+)$/)
      if (match) {
        const [, format, data] = match
        messageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: `image/${format}`,
            data: data
          }
        })
      } else {
        console.warn(`[${conversationId}] Invalid data URI format: ${file.substring(0, 50)}...`)
      }
    }
    console.log(`[${conversationId}] Sending message with ${files.length} image(s)`)
  } else {
    messageContent = content
  }

  const userMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: messageContent
    }
  }

  console.log(`[${conversationId}] Sending to Claude:`, JSON.stringify(userMessage).substring(0, 200))
  claudeProcess.stdin.write(JSON.stringify(userMessage) + '\n')
}

app.get('/conversations/:id/stream', (req, res) => {
  const { id } = req.params

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  activeStreams.set(id, res)

  req.on('close', () => {
    activeStreams.delete(id)
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
    type: 'control',
    action: 'approve',
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
    type: 'control',
    action: 'deny',
    requestId,
    reason
  }) + '\n')

  res.json({
    success: true
  })
})

function tryStartServer(ports, index = 0) {
  if (index >= ports.length) {
    console.error(`\n❌ Failed to start server on any port (tried ${ports.join(', ')})`)
    process.exit(1)
  }

  const port = ports[index]
  const server = app.listen(port)
    .on('listening', () => {
      console.log(`\n✅ ABsmartly Claude Code Bridge running on http://localhost:${port}`)
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

      setupShutdownHandlers(server)
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️  Port ${port} is already in use, trying next port...`)
        tryStartServer(ports, index + 1)
      } else {
        console.error(`\n❌ Error starting server:`, err)
        process.exit(1)
      }
    })
}

function setupShutdownHandlers(server) {
  const shutdown = () => {
    console.log('\nShutting down...')
    if (claudeProcess) {
      claudeProcess.kill()
    }
    server.close(() => {
      console.log('Server closed')
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const portsToTry = PORT ? [PORT] : PREFERRED_PORTS
tryStartServer(portsToTry)
