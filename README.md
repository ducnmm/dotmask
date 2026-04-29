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

## default hosts

- `api.anthropic.com`
- `api.openai.com`
- `openrouter.ai`
- `api.openrouter.ai`
- `generativelanguage.googleapis.com`

`~/.dotmask/config.json` is created automatically and controls the allowed host list.

add a custom host with:

```bash
dotmask allow chat.trollllm.xyz
```

## commands

- `dotmask install`
- `dotmask install --port 18788`
- `dotmask allow chat.trollllm.xyz`
- `dotmask hosts`
- `dotmask disallow chat.trollllm.xyz`
- `dotmask status`
- `dotmask doctor`
- `dotmask uninstall`

## notes

- macOS only
- Node.js 18+
- `openssl` required
- secrets are stored in macOS Keychain

## debug

```bash
DOTMASK_DEBUG=1 node dist/proxy/server.js --port 18787
```

or inspect `~/.dotmask/proxy.err.log`.
