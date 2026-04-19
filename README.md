# dotmask

> Transparent AI secret masking for macOS — your API keys never leave your machine in plaintext.

dotmask runs a local HTTPS proxy between Claude Code and AI APIs. Every outgoing prompt is scanned for secrets; real values are swapped for format-identical fakes before they hit the network, then restored in the AI's response so your tools keep working.

```
You type:   "my key is sk-proj-abc123RealSecret..."
AI sees:    "my key is sk-proj-xT9mW2FakeFakeF..."   ← fake, same format
Tool runs:  curl -H "Bearer sk-proj-abc123RealSecret..."  ← restored locally
```

Real secrets stay in **macOS Keychain** — encrypted, Touch ID–protected, never written to disk.

---

## Install

```bash
npm install -g dotmask
dotmask install
```

macOS will ask you to trust the proxy CA certificate (one-time). Then restart Claude Code — you're done.

## Uninstall

```bash
dotmask uninstall
```

Removes the proxy daemon, CA cert, and Claude Code settings. Restart Claude Code to deactivate.

---

## Commands

| Command | Description |
|---------|-------------|
| `dotmask install` | Set up the proxy |
| `dotmask uninstall` | Remove everything |
| `dotmask status` | Show current proxy status |
| `dotmask doctor` | Diagnose any issues |

```bash
dotmask install --port 18788   # custom port (default: 18787)
dotmask --version
dotmask --help
```

---

## How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│                       macOS Keychain                                │
│   sk-proj-xT9mW2… ──► sk-proj-abc123…   (encrypted, never a file) │
└────────────────────────┬─────────────────────────┬─────────────────┘
                         │                         │
                   mask real→fake            unmask fake→real
                         │                         │
                    ┌────▼────┐               ┌────▼──────┐
   Claude Code ───► │ Request │──► AI API     │ Response  │ ──► Claude Code
                    └─────────┘               └───────────┘
                     secrets replaced          tool-call args
                     before sending            restored before execution
```

**Request masking** — the proxy intercepts every HTTPS request to an AI API, scans the body (messages, system prompt, tool results) for secrets, and replaces each one with a cryptographically-seeded fake token that has the same prefix, length, and character set.

**Response unmasking** — when the AI returns a tool call (e.g. a `curl` command) containing a fake token, the proxy swaps it back to the real value before Claude Code executes it.

**SSE-aware** — streaming responses are fully buffered before unmasking, so fake keys split across multiple chunks are reliably reconstructed.

---

## Detected secret types

| Pattern | Example prefix |
|---------|----------------|
| Anthropic API keys | `sk-ant-api…` |
| OpenAI project keys | `sk-proj-…` |
| OpenRouter keys | `sk-or-v1-…` |
| Generic bearer tokens | `sk-…` |
| Google AI keys | `AIza…` |
| GitHub tokens | `ghp_`, `gho_`, `github_pat_` |
| Slack tokens | `xoxb-`, `xoxp-` |
| Blockchain private keys | `0x…`, `suiprivkey…` |
| Database URLs | `postgres://`, `mysql://`, `mongodb://` |
| High-entropy env vars | detected by Shannon entropy |

---

## Supported AI APIs

- `api.anthropic.com` — Anthropic Claude
- `api.openai.com` — OpenAI / ChatGPT
- `openrouter.ai` — OpenRouter
- `generativelanguage.googleapis.com` — Google Gemini

---

## Debug mode

To see what the proxy is doing (no secret values are logged):

```bash
DOTMASK_DEBUG=1 node dist/proxy/server.js --port 18787
# or check the daemon log:
tail -f ~/.dotmask/proxy.err.log
```

---

## Requirements

- macOS (requires Keychain, launchd, and the `security` CLI)
- Node.js ≥ 18
- `openssl` in PATH (bundled with macOS)

---

## Architecture

```
src/
├── cli.ts                 # CLI entry point (dotmask <command>)
├── utils.ts               # Logging helpers, ANSI colours
├── commands/
│   └── install.ts         # install / uninstall / status / doctor
└── proxy/
    ├── cert.ts            # CA generation & Keychain trust
    ├── daemon.ts          # launchd plist management
    ├── masker.ts          # Secret detection, fake-token generation, Keychain cache
    └── server.ts          # HTTPS MITM proxy — request masking + response unmasking
```

**Zero runtime dependencies** — pure Node.js built-ins only.  
**Format-preserving fakes** — fakes share the same prefix, length, and character set as the real token so the AI treats them as valid.  
**Keychain-backed** — every fake→real pair is stored as a generic Keychain item, readable only by the current user.

---

## License

MIT
