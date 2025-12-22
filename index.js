#!/usr/bin/env node

const express = require('express')
const cors = require('cors')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { JSDOM } = require('jsdom')

const PREFERRED_PORTS = [3000, 3001, 3002, 3003, 3004]
const PORT = process.env.PORT ? parseInt(process.env.PORT) : null

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const claudeProcesses = new Map()
const activeStreams = new Map()
const conversationMessages = new Map()
const sessionTracking = new Map()
const outputBuffers = new Map()
const conversationHtml = new Map() // Stores HTML for chunk retrieval
const conversationModels = new Map() // Stores model selection per conversation

// Global JSON schema - set by extension on first conversation
let globalJsonSchema = null

function checkClaudeAuth() {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json')
    const claudeDir = path.join(os.homedir(), '.claude')

    if (fs.existsSync(credentialsPath)) {
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
        expiresAt,
        method: 'credentials file'
      }
    }

    if (fs.existsSync(claudeDir)) {
      const historyPath = path.join(claudeDir, 'history.jsonl')
      const sessionEnvPath = path.join(claudeDir, 'session-env')

      if (fs.existsSync(historyPath) || fs.existsSync(sessionEnvPath)) {
        const stats = fs.existsSync(historyPath) ? fs.statSync(historyPath) : null
        const recentlyUsed = stats && (Date.now() - stats.mtimeMs) < 24 * 60 * 60 * 1000

        return {
          authenticated: true,
          subscriptionType: null,
          subscriptionNote: 'For subscription details, run: npx @anthropic-ai/claude-code login',
          method: 'session detection',
          lastActivity: stats ? new Date(stats.mtime).toISOString() : 'unknown',
          recentlyUsed
        }
      }
    }

    return {
      authenticated: false,
      error: 'Claude CLI not logged in. Run: npx @anthropic-ai/claude-code login'
    }
  } catch (error) {
    return {
      authenticated: false,
      error: `Failed to check Claude credentials: ${error.message}`
    }
  }
}

// JSON schema for structured DOM changes output
const DOM_CHANGES_SCHEMA = {
  type: 'object',
  properties: {
    domChanges: {
      type: 'array',
      description: 'Array of DOM change objects. Each must have: selector (CSS), type (text|html|style|styleRules|class|attribute|javascript|move|create|delete), and type-specific properties.',
      items: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for target element(s)' },
          type: {
            type: 'string',
            enum: ['text', 'html', 'style', 'styleRules', 'class', 'attribute', 'javascript', 'move', 'create', 'delete'],
            description: 'Type of DOM change to apply'
          },
          value: { description: 'Value for text/html/attribute changes, or CSS object for style changes' },
          css: { type: 'object', description: 'CSS properties object for style type (alternative to value)' },
          states: { type: 'object', description: 'CSS states for styleRules type (normal, hover, active, focus)' },
          add: { type: 'array', items: { type: 'string' }, description: 'Classes to add (for class type)' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Classes to remove (for class type)' },
          element: { type: 'string', description: 'HTML to create (for create type)' },
          targetSelector: { type: 'string', description: 'Target location (for move/create types)' },
          position: { type: 'string', enum: ['before', 'after', 'firstChild', 'lastChild'], description: 'Position relative to target' },
          important: { type: 'boolean', description: 'Add !important flag to styles' },
          waitForElement: { type: 'boolean', description: 'Wait for element to appear (SPA mode)' }
        },
        required: ['selector', 'type']
      }
    },
    response: {
      type: 'string',
      description: 'Markdown explanation of what you changed and why. No action descriptions (no "I\'ll click..." or "Let me navigate...").'
    },
    action: {
      type: 'string',
      enum: ['append', 'replace_all', 'replace_specific', 'remove_specific', 'none'],
      description: 'How to apply changes: append=add to existing, replace_all=clear all first, replace_specific=replace specific selectors, remove_specific=remove specific selectors, none=no changes'
    },
    targetSelectors: {
      type: 'array',
      description: 'CSS selectors to target when action is replace_specific or remove_specific',
      items: { type: 'string' }
    }
  },
  required: ['domChanges', 'response', 'action']
}

function spawnClaudeForConversation(conversationId, systemPrompt, sessionId, isResume = false, model = null) {
  if (claudeProcesses.has(conversationId)) {
    console.log(`Claude CLI already running for conversation ${conversationId}`)
    return claudeProcesses.get(conversationId)
  }

  // Get model from stored settings or use default (sonnet)
  const selectedModel = model || conversationModels.get(conversationId) || 'sonnet'
  console.log(`Spawning Claude CLI process for conversation ${conversationId} with model: ${selectedModel}...`)

  const args = [
    '@anthropic-ai/claude-code',
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--replay-user-messages',
    '--permission-mode', 'default',
    '--allowedTools', 'Bash(curl:*),Bash(npx:*)',  // Allow curl and npx for chunk retrieval
    '--strict-mcp-config',
    '--model', selectedModel,  // Use selected model (sonnet, opus, or haiku)
    '--settings', JSON.stringify({ disableClaudeMd: true })
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

  // Add JSON schema for structured output (use global if provided by extension, otherwise fallback)
  const schemaToUse = globalJsonSchema || DOM_CHANGES_SCHEMA
  console.log(`Adding JSON schema for structured DOM changes output (source: ${globalJsonSchema ? 'extension' : 'fallback'})`)
  args.push('--json-schema', JSON.stringify(schemaToUse))

  console.log(`[${conversationId}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`[${conversationId}] 🚀 SPAWNING CLAUDE CLI WITH ARGUMENTS:`)
  console.log(`[${conversationId}] Command: npx ${args.join(' ')}`)
  console.log(`[${conversationId}] Using --json-schema for structured output`)
  console.log(`[${conversationId}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

  const claudeProcess = spawn('npx', args, {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  claudeProcess.stdout.on('data', (data) => {
    let buffer = outputBuffers.get(conversationId) || ''
    buffer += data.toString()

    const lines = buffer.split('\n')
    buffer = lines.pop()
    outputBuffers.set(conversationId, buffer)

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const event = JSON.parse(line)
        console.log(`[${conversationId}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
        console.log(`[${conversationId}] 📦 RAW EVENT FROM CLAUDE CLI:`)
        console.log(JSON.stringify(event, null, 2))
        console.log(`[${conversationId}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

        const res = activeStreams.get(conversationId)
        if (res) {
          if (event.type === 'assistant' && event.message?.content) {
            console.log(`[${conversationId}] Processing assistant message with ${event.message.content.length} content blocks`)
            for (const block of event.message.content) {
              console.log(`[${conversationId}] Content block type: ${block.type}`)
              if (block.type === 'text' && block.text) {
                // Try to parse as JSON schema response
                try {
                  const parsedJson = JSON.parse(block.text.trim())
                  // Check if it matches our schema (has required fields)
                  if (parsedJson.domChanges && parsedJson.response && parsedJson.action) {
                    console.log(`[${conversationId}] ✅ Parsed JSON schema response, forwarding as structured data`)
                    console.log(`[${conversationId}] Structured data:`, JSON.stringify(parsedJson, null, 2))
                    // Send as tool_use-style event for compatibility
                    res.write(`data: ${JSON.stringify({ type: 'tool_use', data: parsedJson })}\n\n`)
                    // Also send the response text for display
                    if (parsedJson.response) {
                      res.write(`data: ${JSON.stringify({ type: 'text', data: parsedJson.response })}\n\n`)
                    }
                  } else {
                    // Not our schema format, send as regular text
                    res.write(`data: ${JSON.stringify({ type: 'text', data: block.text })}\n\n`)
                  }
                } catch (e) {
                  // Not JSON, send as regular text
                  res.write(`data: ${JSON.stringify({ type: 'text', data: block.text })}\n\n`)
                }
              } else if (block.type === 'tool_use' && block.input) {
                // Handle tool_use blocks (shouldn't happen with --json-schema, but keep for safety)
                console.log(`[${conversationId}] ✅ Found tool_use block, forwarding to client`)
                console.log(`[${conversationId}] Tool input:`, JSON.stringify(block.input, null, 2))
                const toolInput = block.input
                res.write(`data: ${JSON.stringify({ type: 'tool_use', data: toolInput })}\n\n`)
                if (toolInput.response) {
                  res.write(`data: ${JSON.stringify({ type: 'text', data: toolInput.response })}\n\n`)
                }
              } else {
                console.log(`[${conversationId}] ⚠️ Unknown or unhandled content block type:`, block.type)
              }
            }
          } else if (event.type === 'result') {
            console.log(`[${conversationId}] Received result event - sending done`)
            // Don't send result as text - we already sent the assistant message content
            // Just signal that we're done
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
            res.end()
            activeStreams.delete(conversationId)
            outputBuffers.delete(conversationId)
          } else if (event.type === 'error') {
            res.write(`data: ${JSON.stringify({ type: 'error', data: event.error || 'Unknown error' })}\n\n`)
            res.end()
            activeStreams.delete(conversationId)
            outputBuffers.delete(conversationId)
          } else {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          }
        }
      } catch (err) {
        console.error(`[${conversationId}] Failed to parse Claude output:`, err.message, 'Raw:', line.substring(0, 200))

        const res = activeStreams.get(conversationId)
        if (res) {
          res.write(`data: ${JSON.stringify({
            type: 'text',
            data: 'Response generated but encountered parsing error. Check server logs for details.'
          })}\n\n`)
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
          res.end()
          activeStreams.delete(conversationId)
          outputBuffers.delete(conversationId)
        }
      }
    }
  })

  claudeProcess.stderr.on('data', (data) => {
    console.error(`[${conversationId}] Claude CLI stderr:`, data.toString())
  })

  claudeProcess.on('exit', (code) => {
    console.log(`[${conversationId}] Claude CLI exited with code ${code}`)
    claudeProcesses.delete(conversationId)
    outputBuffers.delete(conversationId)
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
  const { session_id, jsonSchema, html, model } = req.body
  const conversationId = session_id || `conv_${Date.now()}`

  conversationMessages.set(conversationId, [])

  // Store HTML for chunk retrieval if provided
  if (html) {
    conversationHtml.set(conversationId, {
      html,
      timestamp: Date.now()
    })
    console.log(`📄 Stored HTML for conversation ${conversationId} (${html.length} chars)`)
  }

  // Store model selection if provided (defaults to sonnet)
  const selectedModel = model || 'sonnet'
  conversationModels.set(conversationId, selectedModel)
  console.log(`🤖 Model for conversation ${conversationId}: ${selectedModel}`)

  // Accept JSON schema from extension if provided (always update to stay in sync)
  if (jsonSchema) {
    console.log('📋 Updating JSON schema from extension')
    globalJsonSchema = jsonSchema
  }

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
  const { content, files, systemPrompt, jsonSchema } = req.body

  // Accept JSON schema if provided (for bridge restarts / schema updates)
  if (jsonSchema) {
    console.log('📋 Updating JSON schema from extension (via /messages)')
    globalJsonSchema = jsonSchema
  }

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

// Extract a single HTML chunk by selector using jsdom
function extractChunk(html, selector, dom = null) {
  try {
    // Reuse DOM if provided, otherwise create new one
    const jsdom = dom || new JSDOM(html)
    const document = jsdom.window.document

    const element = document.querySelector(selector)
    if (element) {
      return { selector, html: element.outerHTML, found: true }
    }

    return { selector, html: '', found: false, error: `Element not found: ${selector}` }
  } catch (error) {
    return { selector, html: '', found: false, error: `Invalid selector: ${error.message}` }
  }
}

// Get HTML chunk(s) by CSS selector(s)
// GET with single selector: ?selector=.hero
// GET with multiple selectors: ?selectors=.hero,header,#main
app.get('/conversations/:id/chunk', (req, res) => {
  const { id } = req.params
  const { selector, selectors } = req.query

  // Support both single selector and multiple selectors
  let selectorList = []
  if (selectors) {
    selectorList = selectors.split(',').map(s => s.trim()).filter(s => s)
  } else if (selector) {
    selectorList = [selector]
  }

  if (selectorList.length === 0) {
    return res.status(400).json({ error: 'Missing selector or selectors query parameter' })
  }

  const stored = conversationHtml.get(id)
  if (!stored) {
    return res.status(404).json({ error: 'Conversation not found or no HTML stored' })
  }

  try {
    const html = stored.html
    // Parse DOM once and reuse for all selectors
    const dom = new JSDOM(html)
    const results = selectorList.map(sel => extractChunk(html, sel, dom))

    // For single selector (backward compatibility), return single object
    if (selectorList.length === 1) {
      const result = results[0]
      if (!result.found) {
        return res.status(404).json(result)
      }
      return res.json(result)
    }

    // For multiple selectors, return array
    return res.json({ results })
  } catch (error) {
    return res.status(500).json({ error: `Failed to extract chunk: ${error.message}` })
  }
})

// POST endpoint for multiple selectors (preferred for complex requests)
app.post('/conversations/:id/chunks', (req, res) => {
  const { id } = req.params
  const { selectors } = req.body

  if (!selectors || !Array.isArray(selectors) || selectors.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid selectors array in request body' })
  }

  const stored = conversationHtml.get(id)
  if (!stored) {
    return res.status(404).json({ error: 'Conversation not found or no HTML stored' })
  }

  try {
    const html = stored.html
    // Parse DOM once and reuse for all selectors
    const dom = new JSDOM(html)
    const results = selectors.map(sel => extractChunk(html, sel, dom))
    return res.json({ results })
  } catch (error) {
    return res.status(500).json({ error: `Failed to extract chunks: ${error.message}` })
  }
})

// Execute XPath query on stored HTML
function executeXPath(html, xpath, maxResults = 10, dom = null) {
  try {
    const jsdom = dom || new JSDOM(html)
    const document = jsdom.window.document
    const window = jsdom.window

    // Helper to generate a CSS selector for an element
    const generateSelector = (element) => {
      if (element.id) {
        return `#${element.id}`
      }

      const tagName = element.tagName.toLowerCase()
      const classes = Array.from(element.classList || []).filter(c => c && !c.includes(':'))

      if (classes.length > 0) {
        const classSelector = `${tagName}.${classes.slice(0, 2).join('.')}`
        if (document.querySelectorAll(classSelector).length === 1) {
          return classSelector
        }
      }

      const parent = element.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === element.tagName)
        if (siblings.length > 1) {
          const index = siblings.indexOf(element) + 1
          const parentSelector = generateSelector(parent)
          return `${parentSelector} > ${tagName}:nth-of-type(${index})`
        }
        const parentSelector = generateSelector(parent)
        return `${parentSelector} > ${tagName}`
      }

      return tagName
    }

    const matches = []
    const xpathResult = document.evaluate(
      xpath,
      document,
      null,
      window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    )

    for (let i = 0; i < Math.min(xpathResult.snapshotLength, maxResults); i++) {
      const node = xpathResult.snapshotItem(i)
      if (!node) continue

      if (node.nodeType === window.Node.ELEMENT_NODE) {
        matches.push({
          selector: generateSelector(node),
          html: node.outerHTML.slice(0, 2000),
          textContent: (node.textContent || '').slice(0, 200),
          nodeType: 'element'
        })
      } else if (node.nodeType === window.Node.TEXT_NODE) {
        const parentElement = node.parentElement
        if (parentElement) {
          matches.push({
            selector: generateSelector(parentElement),
            html: parentElement.outerHTML.slice(0, 2000),
            textContent: (node.textContent || '').slice(0, 200),
            nodeType: 'text'
          })
        }
      } else if (node.nodeType === window.Node.ATTRIBUTE_NODE) {
        matches.push({
          selector: '',
          html: `${node.name}="${node.value}"`,
          textContent: node.value,
          nodeType: 'attribute'
        })
      }
    }

    return { xpath, matches, found: matches.length > 0 }
  } catch (error) {
    return { xpath, matches: [], found: false, error: `XPath error: ${error.message}` }
  }
}

// XPath query endpoint
app.post('/conversations/:id/xpath', (req, res) => {
  const { id } = req.params
  const { xpath, maxResults = 10 } = req.body

  if (!xpath) {
    return res.status(400).json({ error: 'Missing xpath in request body' })
  }

  const stored = conversationHtml.get(id)
  if (!stored) {
    return res.status(404).json({ error: 'Conversation not found or no HTML stored' })
  }

  try {
    const result = executeXPath(stored.html, xpath, maxResults)
    if (!result.found && result.error) {
      return res.status(400).json(result)
    }
    return res.json(result)
  } catch (error) {
    return res.status(500).json({ error: `Failed to execute XPath: ${error.message}` })
  }
})

// Refresh stored HTML for a conversation
app.post('/conversations/:id/refresh', (req, res) => {
  const { id } = req.params
  const { html } = req.body

  if (!html) {
    return res.status(400).json({ error: 'Missing html in request body' })
  }

  const existing = conversationHtml.get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Conversation not found' })
  }

  conversationHtml.set(id, {
    html,
    timestamp: Date.now()
  })

  console.log(`🔄 Refreshed HTML for conversation ${id} (${html.length} chars)`)
  res.json({ success: true })
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
        if (authStatus.subscriptionType) {
          console.log(`✓ Authenticated (${authStatus.subscriptionType})`)
        } else {
          console.log(`✓ Authenticated`)
        }
        if (authStatus.method) {
          console.log(`  Method: ${authStatus.method}`)
        }
        if (authStatus.lastActivity) {
          console.log(`  Last activity: ${authStatus.lastActivity}`)
        }
        if (authStatus.expiresAt) {
          console.log(`  Expires: ${authStatus.expiresAt}`)
        }
        if (authStatus.subscriptionNote) {
          console.log(`  ${authStatus.subscriptionNote}`)
        }
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
      console.log(`  GET  /conversations/:id/chunk     (HTML chunk retrieval)`)
      console.log(`  POST /conversations/:id/refresh   (Update stored HTML)`)
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
