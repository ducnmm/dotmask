# Architecture

## Overview

dotmask is a local HTTPS proxy that intercepts AI tool traffic and masks secrets before they leave the machine.

## Core Components

### 1. CLI (`src/cli.ts`)

Entry point for all user-facing commands:

- `install` / `uninstall` / `status` / `doctor`
- `allow` / `disallow` / `hosts`

### 2. Proxy Server (`src/proxy/server.ts`)

The core MITM proxy that handles:

- HTTPS CONNECT tunnel establishment
- Per-hostname certificate generation
- Request/response masking
- SSE streaming support

Key flow:

```
Client connects to proxy
        │
        ▼
    handleConnect()
        │
        ├─► shouldMitmHost() → check allowed hosts
        │
        ├─► Passthrough: non-allowed hosts bypass proxy
        │
        └─► MITM Mode:
            │
            ├─► Generate host certificate (signed by dotmask CA)
            ├─► Parse HTTP request from TLS stream
            ├─► maskRequestBody() - mask secrets in body
            ├─► Forward to upstream with fake secrets
            ├─► Receive response
            └─► unmaskText() - restore real secrets
```

### 3. Masker (`src/proxy/masker.ts`)

The core secret detection and masking logic.

#### Detection Methods

1. **Known Token Patterns** (`KNOWN_TOKEN_RE`):
   - JWT: `eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{20,}`
   - AWS Key ID: `AKIA[A-Z0-9]{16}`
   - Stripe: `sk_live_...`, `sk_test_...`
   - Anthropic: `sk-ant-api\d{2}-[A-Za-z0-9\-_+/]{20,}`
   - OpenAI: `sk-proj-[A-Za-z0-9\-_+/]{20,}`
   - And more...

2. **High Entropy Detection** (`isHighEntropySecret()`):
   - Shannon entropy >= 3.5
   - Length >= 20 chars
   - Character set matches Base64/Hex patterns

3. **Environment Variable Assignment** (`SECRET_KEY_RE`):
   - Keys matching: `KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE|AUTH`
   - Values >= 16 chars

#### Format-Preserving Fake Generation

```typescript
makeFake(real: string): string
```

1. Extract prefix (known prefixes like `sk-ant-api03-`)
2. Detect charset (Base64, Hex, Alphanumeric, etc.)
3. Generate deterministic random string of same length
4. Return prefix + fake

Uses seed from SHA-256 hash of original value for reproducibility.

#### Keychain Integration

- **Storage**: macOS Keychain with service `dotmask`
- **Account**: Fake key value
- **Password**: Real key value

Cache in memory with 30s TTL to avoid excessive Keychain calls.

### 4. Certificate Management (`src/proxy/cert.ts`)

CA certificate lifecycle:

```
First run:
  └─► Generate RSA-4096 CA key
  └─► Generate CA cert (valid 10 years)
  └─► Install to macOS Keychain
  └─► Trust certificate system-wide

Per-host certificates:
  └─► Generate RSA-2048 host key pair
  └─► Create CSR with hostname as CN
  └─► Sign with dotmask CA
  └─► Cache in memory
```

### 5. Daemon Management (`src/proxy/daemon.ts`)

Uses macOS `launchd` for:

- Auto-start at login (`RunAtLoad`)
- Keep alive (`KeepAlive`)
- Port binding (default 18787)

### 6. Configuration (`src/proxy/config.ts`)

Stored at `~/.dotmask/config.json`:

```json
{
  "allowedHosts": [
    "api.anthropic.com",
    "api.openai.com"
  ]
}
```

## Data Flow

### Request Masking

```
1. Claude Code sends request to api.anthropic.com
2. dotmask intercepts via HTTPS_PROXY
3. Parse request body as JSON
4. maskText() scans for secrets:
   a. Check against known patterns
   b. Check registered (real→fake) mappings
   c. Check high-entropy strings
   d. Check env-var style assignments
5. For each found secret:
   a. Generate fake with makeFake()
   b. Store (real, fake) in Keychain
   c. Replace real with fake in body
6. Forward modified request to upstream
```

### Response Unmasking

```
1. Upstream returns response with fake keys
2. Parse response
3. For each known fake key (from cache):
   a. Lookup real value in Keychain
   b. Replace fake with real
4. Return unmasked response to Claude Code
```

## File Locations

| Path | Purpose |
|------|---------|
| `~/.dotmask/config.json` | Allowed hosts configuration |
| `~/.dotmask/ca/ca.pem` | CA certificate (public) |
| `~/.dotmask/ca/ca.key` | CA private key (secret!) |
| `~/.dotmask/maps/*.json` | List of masked (fake) keys |
| `~/.dotmask/proxy.err.log` | Error/debug log |
| `~/.dotmask/proxy.log` | General log |
| `~/.claude/settings.json` | Claude Code settings (injected) |

## Dependencies

### Runtime

- `node:http` - HTTP server
- `node:https` - HTTPS (not used directly, TLS via node:tls)
- `node:tls` - TLS termination
- `node:crypto` - Key generation, hashing
- `node:child_process` - OpenSSL wrapper

### Build

- `typescript` - TypeScript compilation
- `@types/node` - Node.js types