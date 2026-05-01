# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability within dotmask, please create an issue or contact the maintainer directly.

Please include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

**We ask that you:**
- Give us reasonable time to address the issue before making any public disclosure
- Make a good faith effort to avoid privacy violations, destruction of data, and interruption of service

## Security Design

### MITM Proxy Architecture

dotmask uses a local MITM (Man-in-the-Middle) HTTPS proxy to intercept and modify traffic. This requires:

1. **CA Certificate Generation**: A custom CA is generated at `~/.dotmask/ca/`
2. **System Trust**: The CA must be installed and trusted in macOS Keychain
3. **Local Traffic Only**: Only intercepts traffic to configured AI provider domains

### Key Security Properties

| Property | Implementation |
|----------|----------------|
| Secrets never leave machine | MITM intercepts before TLS, mask before forwarding |
| Format preservation | Fakes maintain same prefix/length/charset as real |
| Secure storage | Real secrets stored in macOS Keychain |
| Memory safety | Secrets cleared from memory after masking |
| Cache TTL | Keychain lookups cached for 30s only |

### Known Limitations

1. **Header masking**: Currently dotmask only masks secrets in request bodies, not HTTP headers
2. **Pattern matching**: Secrets must match known patterns or have high entropy to be masked
3. **Local-only**: CA certificate must be trusted on the same machine

### Threat Model

dotmask protects against:

- ✅ Accidental secret leaks in AI prompts
- ✅ Secrets being stored in AI provider logs
- ✅ Secrets being used for training data

dotmask does NOT protect against:

- ❌ Malicious Claude Code prompts that exfiltrate secrets
- ❌ Compromised AI providers
- ❌ Secrets in file system (use other tools like git-secrets, Talisman)

## Updates

Security advisories will be posted to the GitHub repository.