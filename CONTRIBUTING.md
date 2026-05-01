# Contributing to dotmask

Thank you for your interest in contributing to dotmask!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/ducnmm/dotmask.git
cd dotmask

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run with debug logging
DOTMASK_DEBUG=1 node dist/proxy/server.js --port 18787
```

## Project Structure

```
dotmask/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── utils.ts             # Utilities (colors, logging, platform checks)
│   ├── commands/
│   │   ├── install.ts       # install/uninstall/status/doctor commands
│   │   └── hosts.ts         # allow/disallow/hosts commands
│   └── proxy/
│       ├── server.ts       # Main MITM HTTPS proxy server
│       ├── masker.ts       # Core masking/unmasking logic
│       ├── config.ts       # Host configuration management
│       ├── cert.ts         # CA certificate generation
│       ├── daemon.ts       # launchd daemon management
│       ├── sse.ts          # SSE streaming handling
│       └── http.ts         # HTTP request parsing
├── bin/
│   └── dotmask.js          # Entry point for npm bin
└── test/
    └── *.test.js           # Test files
```

## Adding New Secret Patterns

Edit `src/proxy/masker.ts`:

1. Add pattern to `KNOWN_TOKEN_PARTS` array
2. Add corresponding prefix to `KNOWN_PREFIXES`
3. Add charset detection in `detectCharset()` if needed
4. Test with the new pattern

```typescript
// Example: adding a new API key pattern
String.raw`sk-newprovider-[A-Za-z0-9\-_+/]{20,}`,

// Add to KNOWN_PREFIXES
/^(sk-newprovider-)/,
```

## Adding New AI Providers

Edit `src/proxy/masker.ts`:

```typescript
export const AI_DOMAINS = new Set([
  // existing domains...
  "api.newprovider.com",
]);
```

## Code Style

- TypeScript with strict mode
- 2 spaces indentation
- No semicolons
- Single quotes for strings
- Trailing commas

## Testing

```bash
# Run all tests
npm test

# Run specific test
node --test test/masker.test.js
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes with tests
4. Ensure all tests pass: `npm test`
5. Build: `npm run build`
6. Commit with clear message: `git commit -m "Add support for X"`
7. Push and create PR

## Reporting Issues

Please include:

- macOS version
- Node.js version (`node --version`)
- dotmask version (`dotmask --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output (`~/.dotmask/proxy.err.log`)

## Security Issues

See [SECURITY.md](SECURITY.md) for responsible disclosure guidelines.