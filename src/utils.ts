// ANSI colors
export const c = {
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export const log   = (msg: string) => console.log(`${c.blue("[dotmask]")} ${msg}`);
export const ok    = (msg: string) => console.log(`${c.green("[dotmask]")} ✓ ${msg}`);
export const warn  = (msg: string) => console.log(`${c.yellow("[dotmask]")} ⚠  ${msg}`);
export const error = (msg: string) => console.error(`${c.red("[dotmask]")} ✗ ${msg}`);
export const dim   = (msg: string) => console.log(c.dim(`  ${msg}`));

export function requireMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("macOS Keychain required. dotmask only works on macOS.");
  }
}

export function parsePortFlag(args: string[], defaultPort: number): number {
  const idx = args.indexOf("--port");
  if (idx === -1) return defaultPort;

  const raw = args[idx + 1];
  if (raw === undefined) {
    throw new Error("--port requires a value");
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid --port value: ${raw}`);
  }

  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`port must be between 1 and 65535: ${raw}`);
  }

  return port;
}
