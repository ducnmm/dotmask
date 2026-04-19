import crypto from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ── AI API domains to intercept ───────────────────────────────────────────────
export const AI_DOMAINS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "openrouter.ai",
  "api.openrouter.ai",
  "generativelanguage.googleapis.com",
]);

export function isAiDomain(host: string): boolean {
  const bare = host.replace(/:\d+$/, "");
  return AI_DOMAINS.has(bare);
}

// ── Known token patterns ──────────────────────────────────────────────────────
// All alternatives are listed separately for readability; joined at runtime.
const KNOWN_TOKEN_PARTS = [
  String.raw`eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{20,}`, // JWT
  String.raw`AKIA[A-Z0-9]{16}`,                                                    // AWS key ID
  String.raw`sk_live_[A-Za-z0-9]{24,}`,                                            // Stripe live
  String.raw`sk_test_[A-Za-z0-9]{20,}`,                                            // Stripe test
  String.raw`sk-ant-api\d{2}-[A-Za-z0-9\-_+/]{20,}`,                              // Anthropic
  String.raw`sk-proj-[A-Za-z0-9\-_+/]{20,}`,                                      // OpenAI project
  String.raw`sk-or-v1-[A-Za-z0-9\-_+/]{20,}`,                                     // OpenRouter
  String.raw`sk-proxy-[A-Za-z0-9\-_+/]{20,}`,                                     // generic proxy
  String.raw`sk-[A-Za-z0-9\-_+/]{20,}`,                                           // generic sk-
  String.raw`AIza[A-Za-z0-9\-_]{35,}`,                                             // Google AI
  String.raw`suiprivkey[a-z0-9]{40,}`,                                             // Sui (bech32)
  String.raw`0x[0-9a-fA-F]{40,}`,                                                  // Ethereum/EVM
  String.raw`ghp_[A-Za-z0-9+/]{30,}`,                                             // GitHub PAT
  String.raw`gho_[A-Za-z0-9+/]{30,}`,                                             // GitHub OAuth
  String.raw`github_pat_[A-Za-z0-9_]{25,}`,                                        // GitHub fine-grained
  String.raw`xoxb-[A-Za-z0-9\-+/]{20,}`,                                          // Slack bot
  String.raw`xoxp-[A-Za-z0-9\-+/]{20,}`,                                          // Slack user
  String.raw`(?:postgres|mysql|mongodb):\/\/\S+:\S+@\S+`,                          // DB URLs
];
const KNOWN_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_/+])(${KNOWN_TOKEN_PARTS.join("|")})(?![A-Za-z0-9_+/])`,
  "g",
);


const SECRET_KEY_RE = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH/i;

// ── Fake token generation ─────────────────────────────────────────────────────
const KNOWN_PREFIXES = [
  /^(sk-ant-api\d+-)/,
  /^(sk-proj-)/,
  /^(sk-or-v1-)/,
  /^(sk-proxy-)/,
  /^(sk_live_)/,      // Stripe live (underscore)
  /^(sk_test_)/,      // Stripe test (underscore)
  /^(sk-live-)/,
  /^(sk-test-)/,
  /^(sk-[a-zA-Z0-9]+-)/,
  /^(sk-)/,
  /^(AKIA)/,          // AWS Access Key ID
  /^(AIza)/,
  /^(suiprivkey)/,
  /^(0x)/,
  /^(ghp_)/,
  /^(gho_)/,
  /^(github_pat_)/,
  /^(xoxb-)/,
  /^(xoxp-)/,
  /^(postgres:\/\/[^:]+:)/,
  /^(mysql:\/\/[^:]+:)/,
  /^(mongodb:\/\/[^:]+:)/,
];

function detectCharset(payload: string): string {
  if (/^[0-9a-f]+$/.test(payload)) return "0123456789abcdef";
  if (/^[0-9A-F]+$/.test(payload)) return "0123456789ABCDEF";
  if (/^[0-9a-fA-F]+$/.test(payload)) return "0123456789abcdefABCDEF";
  // Check URL-safe charset BEFORE standard Base64 — prevents fake keys from
  // containing '+' and '/' which break the KNOWN_TOKEN_RE and unmask step.
  if (/^[A-Za-z0-9_-]+$/.test(payload)) return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  // Only use standard Base64 charset when the payload genuinely contains + or /
  if (/^[A-Za-z0-9+/]+=*$/.test(payload)) return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
}

function extractPrefix(value: string): string {
  for (const pat of KNOWN_PREFIXES) {
    const m = value.match(pat);
    if (m) return m[1];
  }
  return value.slice(0, Math.max(3, Math.floor(value.length / 5)));
}

export function makeFake(value: string): string {
  if (value.length < 8) return value;

  // JWT special case: preserve the three-part dot-separated structure (header.payload.signature).
  // The fake starts with "eyJ" so it remains recognisable as a JWT.
  if (value.startsWith("eyJ")) {
    const parts = value.split(".");
    if (parts.length === 3) {
      const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
      const fakeParts = parts.map((part, idx) => {
        const hash = crypto.createHash("sha256").update(value + `:${idx}`).digest("hex");
        let rng = parseInt(hash.slice(0, 8), 16);
        const chars = Array.from({ length: part.length }, () => {
          rng = (rng * 1664525 + 1013904223) >>> 0;
          return charset[rng % charset.length];
        }).join("");
        return idx === 0 ? "eyJ" + chars.slice(3) : chars;
      });
      return fakeParts.join(".");
    }
  }

  const prefix = extractPrefix(value);
  const payload = value.slice(prefix.length);
  if (!payload) return value;

  const charset = detectCharset(payload);
  const hash = crypto.createHash("sha256").update(value).digest("hex");
  const seed = parseInt(hash.slice(0, 8), 16);

  const stripped = payload.replace(/=+$/, "");
  const padding = "=".repeat(payload.length - stripped.length);

  let rng = seed;
  const fake = Array.from({ length: stripped.length }, () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return charset[rng % charset.length];
  }).join("") + padding;

  return prefix + fake;
}

// ── Shannon entropy ───────────────────────────────────────────────────────────
function shannonEntropy(s: string): number {
  const counts: Record<string, number> = {};
  for (const c of s) counts[c] = (counts[c] ?? 0) + 1;
  const len = s.length;
  return -Object.values(counts).reduce((acc, v) => {
    const p = v / len;
    return acc + p * Math.log2(p);
  }, 0);
}

function isHighEntropySecret(value: string): boolean {
  if (value.length < 20 || value.includes("...")) return false;
  const entropy = shannonEntropy(value);
  if (entropy >= 3.5 && /^[A-Za-z0-9+/\-_=]{20,}$/.test(value)) return true;
  if (/^[0-9a-fA-F]{40,}$/.test(value)) return true;
  if (value.length >= 40 && /^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)) return true;
  return false;
}

// ── Keychain integration ──────────────────────────────────────────────────────
const KEYCHAIN_SERVICE = "dotmask";
const MAPS_DIR = path.join(os.homedir(), ".dotmask", "maps");
const PROMPT_MAP_FILE = path.join(MAPS_DIR, "proxy-discovered.json");


function keychainLookup(fakeKey: string): string | null {
  try {
    const result = execFileSync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", fakeKey, "-w",
    ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Async parallel version — used when building the cache. */
async function keychainLookupAsync(fakeKey: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", fakeKey, "-w",
    ], { encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function keychainStore(fakeKey: string, realValue: string): void {
  try {
    execFileSync("security", [
      "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", fakeKey,
    ], { stdio: "pipe" });
  } catch { /* ok — might not exist */ }
  try {
    execFileSync("security", [
      "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", fakeKey, "-w", realValue,
    ], { stdio: "pipe" });
  } catch { /* ignore */ }
}

function registerMapping(real: string, fake: string): void {
  // Guard: if the "real" value is itself already a known fake key, skip to
  // avoid circular mappings (fake → real registered as real → another fake).
  if (fakeToRealCache?.has(real)) {
    return;
  }
  // Guard: don't register if real and fake are the same (should not happen,
  // but protects against makeFake returning the original value).
  if (real === fake) return;

  fs.mkdirSync(MAPS_DIR, { recursive: true });
  let existing: string[] = [];
  if (fs.existsSync(PROMPT_MAP_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(PROMPT_MAP_FILE, "utf8")); } catch { /**/ }
  }
  keychainStore(fake, real);
  if (!existing.includes(fake)) {
    existing.push(fake);
    fs.writeFileSync(PROMPT_MAP_FILE, JSON.stringify(existing, null, 2) + "\n", "utf8");
    fs.chmodSync(PROMPT_MAP_FILE, 0o600);
  }
  invalidateCache(); // force reload on next request
}

// ── Keychain map cache (avoid repeated CLI calls per request) ─────────────────
const CACHE_TTL_MS = 30_000; // 30 seconds
let realToFakeCache: Map<string, string> | null = null;
let fakeToRealCache: Map<string, string> | null = null;
let cacheTime = 0;

function isCacheValid(): boolean {
  return Date.now() - cacheTime < CACHE_TTL_MS && realToFakeCache !== null;
}

function invalidateCache(): void {
  realToFakeCache = null;
  fakeToRealCache = null;
  cacheTime = 0;
}

/** Load real→fake + fake→real maps from Keychain in parallel. */
async function buildCacheAsync(): Promise<void> {
  if (!fs.existsSync(MAPS_DIR)) {
    realToFakeCache = new Map();
    fakeToRealCache = new Map();
    cacheTime = Date.now();
    return;
  }

  // Collect all unique fake keys across all map files
  const allFakeKeys = new Set<string>();
  const jsonFiles = fs.readdirSync(MAPS_DIR).filter(f => f.endsWith(".json"));
  for (const file of jsonFiles) {
    try {
      const fakeKeys: unknown = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, file), "utf8"));
      if (Array.isArray(fakeKeys)) fakeKeys.forEach(k => allFakeKeys.add(k as string));
    } catch { /* skip */ }
  }

  // Lookup ALL keys in parallel
  const keys = [...allFakeKeys];
  const values = await Promise.all(keys.map(k => keychainLookupAsync(k)));

  const r2f = new Map<string, string>();
  const f2r = new Map<string, string>();
  for (let i = 0; i < keys.length; i++) {
    const fake = keys[i];
    const real = values[i];
    if (real) {
      if (!r2f.has(real)) r2f.set(real, fake);
      f2r.set(fake, real);
    }
  }

  realToFakeCache = r2f;
  fakeToRealCache = f2r;
  cacheTime = Date.now();
}

// In-flight cache build promise — prevents multiple parallel rebuilds
let cacheBuilding: Promise<void> | null = null;

async function ensureCache(): Promise<void> {
  if (isCacheValid()) return;
  if (!cacheBuilding) {
    cacheBuilding = buildCacheAsync().finally(() => { cacheBuilding = null; });
  }
  await cacheBuilding;
}

/** Load real→fake map (async, parallel Keychain lookups). */
export async function loadRealToFakeMapAsync(): Promise<Map<string, string>> {
  await ensureCache();
  return realToFakeCache ?? new Map();
}

/** Load fake→real map (async, parallel Keychain lookups). */
export async function loadFakeToRealMapAsync(): Promise<Map<string, string>> {
  await ensureCache();
  return fakeToRealCache ?? new Map();
}

/** Sync fallback — uses cache if warm, otherwise cold Keychain calls. */
export function loadRealToFakeMap(): Map<string, string> {
  if (isCacheValid()) return realToFakeCache!;

  const map = new Map<string, string>();
  if (!fs.existsSync(MAPS_DIR)) return map;

  const jsonFiles = fs.readdirSync(MAPS_DIR).filter(f => f.endsWith(".json"));
  for (const file of jsonFiles) {
    try {
      const fakeKeys: unknown = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, file), "utf8"));
      if (!Array.isArray(fakeKeys)) continue;
      for (const fake of fakeKeys as string[]) {
        const real = keychainLookup(fake);
        if (real && !map.has(real)) map.set(real, fake);
      }
    } catch { /* skip corrupt files */ }
  }

  realToFakeCache = map;
  cacheTime = Date.now();
  return map;
}

/** Sync fallback — uses cache if warm. */
export function loadFakeToRealMap(): Map<string, string> {
  if (isCacheValid() && fakeToRealCache) return fakeToRealCache;
  // Fall back: derive from realToFakeMap
  const r2f = loadRealToFakeMap();
  const f2r = new Map<string, string>();
  for (const [real, fake] of r2f) f2r.set(fake, real);
  fakeToRealCache = f2r;
  return f2r;
}

// ── Core masking (request: real → fake) ──────────────────────────────────────

export function maskText(text: string, realToFake: Map<string, string>): { masked: string; count: number } {
  let masked = text;
  let count = 0;

  // 1. Replace known registered real values (longest first)
  const sorted = [...realToFake.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [real, fake] of sorted) {
    if (masked.includes(real)) {
      masked = masked.split(real).join(fake);
      count++;
    }
  }

  // 2. Scan for well-known token patterns not yet in Keychain
  masked = masked.replace(KNOWN_TOKEN_RE, (token) => {
    if ([...realToFake.values()].includes(token)) return token; // already fake
    const fake = makeFake(token);
    if (fake === token) return token;
    registerMapping(token, fake);
    realToFake.set(token, fake);
    count++;
    return fake;
  });

  // 3. Scan env-var assignment lines — but skip values that step 2 already replaced.
  const knownFakes = new Set(realToFake.values()); // fakes registered so far
  masked = masked.replace(
    /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm,
    (line, key: string, rawValue: string) => {
      const value = rawValue.trim();
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      const unquoted = quoted ? value.slice(1, -1) : value;

      const isSecretKey = SECRET_KEY_RE.test(key);
      if ((isSecretKey && unquoted.length >= 16) || isHighEntropySecret(unquoted)) {
        if (realToFake.has(unquoted)) return line;  // already registered as real
        if (knownFakes.has(unquoted)) return line;  // already a fake — don't double-mask
        const fake = makeFake(unquoted);
        if (fake === unquoted) return line;
        registerMapping(unquoted, fake);
        realToFake.set(unquoted, fake);
        knownFakes.add(fake);
        count++;
        if (value.startsWith('"')) return `${key}="${fake}"`;
        if (value.startsWith("'")) return `${key}='${fake}'`;
        return `${key}=${fake}`;
      }
      return line;
    },
  );

  return { masked, count };
}

// ── Unmasking (response: fake → real) ────────────────────────────────────────

/**
 * Unmask fake tokens back to real values.
 * Used on responses from Anthropic so Claude Code can use the real secrets locally.
 */
export function unmaskText(text: string, fakeToReal: Map<string, string>): { unmasked: string; count: number } {
  let unmasked = text;
  let count = 0;

  // Sort by fake key length descending to avoid partial replacements
  const sorted = [...fakeToReal.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [fake, real] of sorted) {
    if (unmasked.includes(fake)) {
      unmasked = unmasked.split(fake).join(real);
      count++;
    }
  }
  return { unmasked, count };
}

/**
 * Mask secrets in a parsed Anthropic/OpenAI messages array (request).
 */
export function maskMessages(messages: unknown[]): number {
  const realToFake = loadRealToFakeMap();
  let total = 0;

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;

    if (typeof m.content === "string") {
      const { masked, count } = maskText(m.content, realToFake);
      m.content = masked;
      total += count;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") {
            const { masked, count } = maskText(p.text, realToFake);
            p.text = masked;
            total += count;
          }
        }
      }
    }
  }
  return total;
}

/**
 * Finds the safe length of string that can be flushed to the client without
 * accidentally truncating a fake token prefix that could be reconstructed in the next chunk.
 */
export function findSafeFlushLength(text: string, fakeKeys: string[]): number {
  let minSafeLength = text.length;
  for (const fk of fakeKeys) {
    const maxSuffixLen = Math.min(text.length, fk.length);
    for (let i = 0; i < maxSuffixLen; i++) {
       const suffixLen = maxSuffixLen - i;
       const suffixStartIndex = text.length - suffixLen;
       if (suffixStartIndex >= minSafeLength) continue;

       let match = true;
       for (let j = 0; j < suffixLen; j++) {
         if (text[suffixStartIndex + j] !== fk[j]) {
           match = false;
           break;
         }
       }
       if (match) {
         // Only hold back for a STRICT PREFIX of fk (key may continue in next chunk).
         // If suffixLen === fk.length the complete key is present → safe to flush.
         if (suffixLen < fk.length) {
           minSafeLength = Math.min(minSafeLength, suffixStartIndex);
         }
         break;
       }
    }
  }
  return minSafeLength;
}
