# @absmartly/claude-code-bridge

HTTP bridge server that enables the ABsmartly Browser Extension to communicate with Claude Code CLI for AI-powered A/B testing features.

## Prerequisites

- Node.js 16+
- Claude Code CLI authenticated: `npx @anthropic-ai/claude-code login`

## Quick Start

```bash
npx @absmartly/claude-code-bridge
```

The server will start on `http://localhost:3000` by default.

## Usage

### 1. Login to Claude CLI (one-time setup)

```bash
npx @anthropic-ai/claude-code login
```

Follow the prompts to authenticate with your Claude subscription.

### 2. Start the bridge server

```bash
npx @absmartly/claude-code-bridge
```

### 3. Configure ABsmartly Extension

In the extension settings:
1. Select "Claude Subscription" as your AI provider
2. The extension will automatically connect to `http://localhost:3000`

### Custom Port

```bash
PORT=3001 npx @absmartly/claude-code-bridge
```

## API Endpoints

- `GET /health` - Health check and auth status
- `GET /auth/status` - Claude CLI authentication status
- `POST /conversations` - Create new conversation
- `POST /conversations/:id/messages` - Send message to Claude
- `GET /conversations/:id/stream` - Stream Claude responses (SSE)
- `POST /conversations/:id/approve` - Approve tool use
- `POST /conversations/:id/deny` - Deny tool use

## How It Works

1. **Authentication Check**: Reads your Claude credentials from `~/.claude/.credentials.json`
2. **Claude CLI Spawn**: Spawns `npx @anthropic-ai/claude-code --json` subprocess
3. **HTTP Bridge**: Provides REST API for the browser extension to communicate
4. **Message Forwarding**: Routes messages between the extension and Claude CLI
5. **Server-Sent Events**: Streams Claude responses back to the extension in real-time

## Troubleshooting

### "Claude CLI not logged in"

Run: `npx @anthropic-ai/claude-code login`

### "Port already in use"

Either:
- Kill the existing process: `pkill -f claude-code-bridge`
- Or use a different port: `PORT=3001 npx @absmartly/claude-code-bridge`

### Extension can't connect

- Ensure the bridge is running: `http://localhost:3000/health` should return JSON
- Check the port matches in extension settings
- Restart the extension

## License

MIT
