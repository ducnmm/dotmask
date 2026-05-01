# dotmask

mask secrets before they leave your machine.

`dotmask` runs a local HTTPS proxy for Claude Code and similar tools. it replaces real secrets with format-preserving fakes on the way out, then restores them locally on the way back.

## install

```bash
npm install -g @ducnmm/dotmask
dotmask install
```

restart Claude Code after install.

## use

use Claude Code like normal. dotmask runs automatically after install.

## supported providers

- `api.anthropic.com` - Anthropic (Claude)
- `api.openai.com` - OpenAI (GPT)
- `openrouter.ai`, `api.openrouter.ai` - OpenRouter
- `generativelanguage.googleapis.com` - Google AI (Gemini)
- `api.deepseek.com` - DeepSeek
- `api.groq.com` - Groq
- `api.moonshot.ai` - Moonshot (Kimi)
- `api.together.ai` - Together AI
- `api.fireworks.ai` - Fireworks AI
- `api.cerebras.ai` - Cerebras
- `api.x.ai` - xAI (Grok)
- `api.inference.huggingface.co` - Hugging Face
- `api.minimax.io`, `api.minimax.chat` - MiniMax

`~/.dotmask/config.json` controls the allowed host list.

add a custom host with:

```bash
dotmask allow chat.trollllm.xyz
```

## commands

- `dotmask install` - install proxy
- `dotmask install --port 18788` - custom port
- `dotmask allow <host>` - add allowed host
- `dotmask disallow <host>` - remove host
- `dotmask hosts` - list allowed hosts
- `dotmask status` - show status
- `dotmask doctor` - diagnose issues
- `dotmask uninstall` - remove everything

## how it works

1. your prompt with API keys goes to Claude Code
2. dotmask intercepts and replaces real keys with fakes
3. fake keys go to the AI API - API thinks its valid
4. response comes back with fake keys
5. dotmask swaps fakes back to real keys
6. Claude Code sees the real response

your secrets never leave your machine.

## supported secrets

- Anthropic keys: `sk-ant-api03-...`
- OpenAI keys: `sk-proj-...`, `sk-...`
- Stripe: `sk_live_...`, `sk_test_...`
- AWS: `AKIA...`
- Google AI: `AIza...`
- GitHub PATs: `ghp_...`, `gho_...`, `github_pat_...`
- Slack: `xoxb-...`, `xoxp-...`
- JWT tokens
- Database URLs: `postgres://user:pass@...`
- EVM private keys: `0x...` (64 chars)

## debugging

```bash
# view logs
tail -f ~/.dotmask/proxy.err.log

# run manually with debug
DOTMASK_DEBUG=1 node dist/proxy/server.js --port 18787
```

## notes

- macOS only
- Node.js 18+
- `openssl` required
- secrets stored in macOS Keychain

## license

MIT