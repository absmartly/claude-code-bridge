#!/usr/bin/env node

const http = require('http')
const https = require('https')

function parseArgs(args) {
  const result = {
    conversationId: null,
    selectors: [],
    bridgeUrl: 'http://localhost:3000'
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--conversation-id' && args[i + 1]) {
      result.conversationId = args[++i]
    } else if (arg === '--selector' && args[i + 1]) {
      result.selectors.push(args[++i])
    } else if (arg === '--selectors' && args[i + 1]) {
      // Support comma-separated list
      result.selectors.push(...args[++i].split(',').map(s => s.trim()).filter(s => s))
    } else if (arg === '--bridge-url' && args[i + 1]) {
      result.bridgeUrl = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: get-chunk --conversation-id <id> --selector <selector> [--selector <selector2>...] [options]

Options:
  --conversation-id <id>    Required. The conversation ID to retrieve HTML from.
  --selector <selector>     Required. CSS selector for the element to retrieve.
                            Can be specified multiple times for multiple selectors.
  --selectors <list>        Comma-separated list of CSS selectors (alternative to multiple --selector).
  --bridge-url <url>        Bridge server URL (default: http://localhost:3000)
  --help, -h                Show this help message.

Examples:
  # Single selector
  get-chunk --conversation-id conv-123 --selector "#main-content"

  # Multiple selectors (using --selector multiple times)
  get-chunk --conversation-id conv-123 --selector ".hero-section" --selector "header" --selector "#main"

  # Multiple selectors (using comma-separated --selectors)
  get-chunk --conversation-id conv-123 --selectors ".hero-section,header,#main"
`)
      process.exit(0)
    }
  }

  return result
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http

    client.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve({ status: res.statusCode, data: json })
        } catch (e) {
          resolve({ status: res.statusCode, data: data })
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  if (!opts.conversationId) {
    console.error('Error: --conversation-id is required')
    process.exit(1)
  }

  if (opts.selectors.length === 0) {
    console.error('Error: --selector is required')
    process.exit(1)
  }

  // Use comma-separated selectors in query param
  const selectorsParam = opts.selectors.length === 1
    ? `selector=${encodeURIComponent(opts.selectors[0])}`
    : `selectors=${encodeURIComponent(opts.selectors.join(','))}`

  const url = `${opts.bridgeUrl}/conversations/${encodeURIComponent(opts.conversationId)}/chunk?${selectorsParam}`

  try {
    const response = await fetch(url)

    if (response.status === 404) {
      console.error(`Error: ${response.data.error || 'Element not found'}`)
      process.exit(1)
    }

    if (response.status !== 200) {
      console.error(`Error: ${response.data.error || 'Request failed'}`)
      process.exit(1)
    }

    // Handle single selector response (backward compatible)
    if (response.data.found !== undefined) {
      if (response.data.found) {
        console.log(response.data.html)
      } else {
        console.error(`Error: Element not found for selector: ${opts.selectors[0]}`)
        process.exit(1)
      }
      return
    }

    // Handle multiple selectors response
    if (response.data.results) {
      for (const result of response.data.results) {
        console.log(`\n## ${result.selector}`)
        if (result.found) {
          console.log(result.html)
        } else {
          console.log(`Error: ${result.error || 'Element not found'}`)
        }
      }
    }
  } catch (error) {
    console.error(`Error: Failed to connect to bridge server at ${opts.bridgeUrl}`)
    console.error(`Make sure the bridge is running: npx @absmartly/claude-code-bridge`)
    process.exit(1)
  }
}

main()
