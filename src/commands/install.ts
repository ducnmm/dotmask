import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok, warn, log, error, c, parsePortFlag } from "../utils.js";
import { CA_CERT_PATH, certExists, isCertTrusted, installCert, uninstallCert } from "../proxy/cert.js";
import { installDaemon, uninstallDaemon, isDaemonLoaded, isDaemonRunning } from "../proxy/daemon.js";

const DEFAULT_PORT = 18787;
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const DOTMASK_META_KEY = "dotmask";

type SettingsReadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string };

interface ProxyConfigState {
  env: Record<string, unknown>;
  hasManagedProxy: boolean;
  hasManagedCert: boolean;
  usesDotmaskProxy: boolean;
  usesDotmaskCert: boolean;
  hasConflictingProxy: boolean;
  hasConflictingCert: boolean;
}

interface InjectResult {
  updated: boolean;
  proxyManaged: boolean;
  certManaged: boolean;
  warnings: string[];
}

interface RemoveResult {
  updated: boolean;
  removedProxy: boolean;
  removedCert: boolean;
}

interface DoctorDependencies {
  daemonLoaded: boolean;
  daemonRunning: boolean;
  certExists: boolean;
  certTrusted: boolean;
}

export function dotmaskProxyValue(port: number): string {
  return `http://localhost:${port}`;
}

function getPort(args: string[]): number {
  return parsePortFlag(args, DEFAULT_PORT);
}

// ── settings.json helpers ─────────────────────────────────────────────────────

export function readSettings(p: string): SettingsReadResult {
  if (!fs.existsSync(p)) return { ok: true, data: {} };

  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `${p} must contain a JSON object` };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      reason: `failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function writeSettings(p: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readManagedEnv(cfg: Record<string, unknown>): Record<string, boolean> {
  const meta = cfg[DOTMASK_META_KEY];
  if (!meta || typeof meta !== "object") return {};
  const managedEnv = (meta as Record<string, unknown>).managedEnv;
  if (!managedEnv || typeof managedEnv !== "object") return {};

  return Object.fromEntries(
    Object.entries(managedEnv as Record<string, unknown>).filter(([, value]) => value === true),
  ) as Record<string, boolean>;
}

function writeManagedEnv(cfg: Record<string, unknown>, managedEnv: Record<string, boolean>): void {
  const existingMeta = cfg[DOTMASK_META_KEY];
  const nextMeta = existingMeta && typeof existingMeta === "object"
    ? { ...(existingMeta as Record<string, unknown>) }
    : {};

  if (Object.keys(managedEnv).length === 0) {
    delete nextMeta.managedEnv;
    if (Object.keys(nextMeta).length === 0) {
      delete cfg[DOTMASK_META_KEY];
    } else {
      cfg[DOTMASK_META_KEY] = nextMeta;
    }
    return;
  }

  nextMeta.managedEnv = managedEnv;
  cfg[DOTMASK_META_KEY] = nextMeta;
}

function normalizeManagedPort(value: unknown): number | null {
  const port = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof port !== "number" || !Number.isInteger(port)) return null;
  if (port < 1 || port > 65535) return null;
  return port;
}

function writeManagedPort(cfg: Record<string, unknown>, port: number | null): void {
  const existingMeta = cfg[DOTMASK_META_KEY];
  const nextMeta = existingMeta && typeof existingMeta === "object"
    ? { ...(existingMeta as Record<string, unknown>) }
    : {};

  if (port === null) {
    delete nextMeta.port;
    if (Object.keys(nextMeta).length === 0) {
      delete cfg[DOTMASK_META_KEY];
    } else {
      cfg[DOTMASK_META_KEY] = nextMeta;
    }
    return;
  }

  nextMeta.port = port;
  cfg[DOTMASK_META_KEY] = nextMeta;
}

export function resolveManagedPort(cfg: Record<string, unknown>): number {
  const meta = cfg[DOTMASK_META_KEY];
  if (meta && typeof meta === "object") {
    const port = normalizeManagedPort((meta as Record<string, unknown>).port);
    if (port !== null) return port;
  }

  const env = cfg.env && typeof cfg.env === "object" ? cfg.env as Record<string, unknown> : {};
  const httpsProxy = env["HTTPS_PROXY"];
  const proxyMatch = typeof httpsProxy === "string"
    ? /^http:\/\/localhost:(\d+)$/.exec(httpsProxy)
    : null;
  const hasManagedProxy = readManagedEnv(cfg)["HTTPS_PROXY"] === true;
  const legacyManaged = proxyMatch !== null && env["NODE_EXTRA_CA_CERTS"] === CA_CERT_PATH;

  if ((hasManagedProxy || legacyManaged) && proxyMatch) {
    const port = normalizeManagedPort(proxyMatch[1]);
    if (port !== null) return port;
  }

  return DEFAULT_PORT;
}

export function getProxyConfigState(cfg: Record<string, unknown>, port: number): ProxyConfigState {
  const env = cfg.env && typeof cfg.env === "object" ? { ...(cfg.env as Record<string, unknown>) } : {};
  const managedEnv = readManagedEnv(cfg);
  const proxyValue = dotmaskProxyValue(port);
  const httpsProxy = env["HTTPS_PROXY"];
  const certPath = env["NODE_EXTRA_CA_CERTS"];

  const hasManagedProxy = managedEnv["HTTPS_PROXY"] === true;
  const hasManagedCert = managedEnv["NODE_EXTRA_CA_CERTS"] === true;
  const usesDotmaskProxy = httpsProxy === proxyValue;
  const usesDotmaskCert = certPath === CA_CERT_PATH;

  return {
    env,
    hasManagedProxy,
    hasManagedCert,
    usesDotmaskProxy,
    usesDotmaskCert,
    hasConflictingProxy: typeof httpsProxy === "string" && !usesDotmaskProxy,
    hasConflictingCert: typeof certPath === "string" && !usesDotmaskCert,
  };
}

export function applyProxySettings(cfg: Record<string, unknown>, port: number): {
  nextConfig: Record<string, unknown>;
  result: InjectResult;
} {
  const nextConfig: Record<string, unknown> = { ...cfg };
  const state = getProxyConfigState(nextConfig, port);
  const managedEnv = readManagedEnv(nextConfig);
  const proxyValue = dotmaskProxyValue(port);
  const warnings: string[] = [];
  let updated = false;

  if (!state.hasConflictingProxy) {
    if (state.env["HTTPS_PROXY"] !== proxyValue) {
      state.env["HTTPS_PROXY"] = proxyValue;
      updated = true;
    }
    managedEnv["HTTPS_PROXY"] = true;
  } else {
    warnings.push(`left existing HTTPS_PROXY unchanged: ${String(state.env["HTTPS_PROXY"])}`);
  }

  if (!state.hasConflictingCert) {
    if (state.env["NODE_EXTRA_CA_CERTS"] !== CA_CERT_PATH) {
      state.env["NODE_EXTRA_CA_CERTS"] = CA_CERT_PATH;
      updated = true;
    }
    managedEnv["NODE_EXTRA_CA_CERTS"] = true;
  } else {
    warnings.push(`left existing NODE_EXTRA_CA_CERTS unchanged: ${String(state.env["NODE_EXTRA_CA_CERTS"])}`);
  }

  nextConfig.env = state.env;
  writeManagedEnv(nextConfig, managedEnv);
  writeManagedPort(nextConfig, port);

  return {
    nextConfig,
    result: {
      updated,
      proxyManaged: managedEnv["HTTPS_PROXY"] === true,
      certManaged: managedEnv["NODE_EXTRA_CA_CERTS"] === true,
      warnings,
    },
  };
}

export function removeProxySettings(cfg: Record<string, unknown>): {
  nextConfig: Record<string, unknown>;
  result: RemoveResult;
} {
  const nextConfig: Record<string, unknown> = { ...cfg };
  const env = nextConfig.env && typeof nextConfig.env === "object" ? { ...(nextConfig.env as Record<string, unknown>) } : {};
  const managedEnv = readManagedEnv(nextConfig);
  const httpsProxy = env["HTTPS_PROXY"];
  const legacyManaged =
    typeof httpsProxy === "string" &&
    /^http:\/\/localhost:\d+$/.test(httpsProxy) &&
    env["NODE_EXTRA_CA_CERTS"] === CA_CERT_PATH;

  let removedProxy = false;
  let removedCert = false;

  if (managedEnv["HTTPS_PROXY"] === true || legacyManaged) {
    removedProxy = Object.prototype.hasOwnProperty.call(env, "HTTPS_PROXY");
    delete env["HTTPS_PROXY"];
  }
  if (managedEnv["NODE_EXTRA_CA_CERTS"] === true || legacyManaged) {
    removedCert = Object.prototype.hasOwnProperty.call(env, "NODE_EXTRA_CA_CERTS");
    delete env["NODE_EXTRA_CA_CERTS"];
  }

  delete managedEnv["HTTPS_PROXY"];
  delete managedEnv["NODE_EXTRA_CA_CERTS"];
  nextConfig.env = env;
  writeManagedEnv(nextConfig, managedEnv);
  writeManagedPort(nextConfig, null);

  return {
    nextConfig,
    result: { updated: removedProxy || removedCert, removedProxy, removedCert },
  };
}

export function buildDoctorChecks(
  settings: SettingsReadResult,
  port: number,
  deps: DoctorDependencies,
): Array<[string, boolean, string]> {
  const settingsState = settings.ok ? getProxyConfigState(settings.data, port) : null;

  return [
    ["Proxy daemon loaded", deps.daemonLoaded, "Run dotmask install"],
    ["Proxy daemon running", deps.daemonRunning, "Run dotmask install or check ~/.dotmask/proxy.err.log"],
    ["CA cert exists", deps.certExists, "Restart proxy — it generates CA on first run"],
    ["CA cert trusted", deps.certTrusted, "Run dotmask install (triggers macOS trust dialog)"],
    [
      "Claude Code settings readable",
      settings.ok,
      "Fix ~/.claude/settings.json so it contains valid JSON",
    ],
    [
      "Claude Code HTTPS_PROXY uses dotmask",
      settingsState?.usesDotmaskProxy === true,
      settingsState?.hasConflictingProxy
        ? `Remove conflicting HTTPS_PROXY (${String(settingsState.env["HTTPS_PROXY"])}) or point it to dotmask`
        : "Run dotmask install",
    ],
    [
      "Claude Code NODE_EXTRA_CA_CERTS uses dotmask",
      settingsState?.usesDotmaskCert === true,
      settingsState?.hasConflictingCert
        ? `Remove conflicting NODE_EXTRA_CA_CERTS (${String(settingsState.env["NODE_EXTRA_CA_CERTS"])}) or point it to ${CA_CERT_PATH}`
        : "Run dotmask install",
    ],
  ];
}

function injectProxy(settingsPath: string, port: number): InjectResult {
  const settings = readSettings(settingsPath);
  if (!settings.ok) {
    throw new Error(settings.reason);
  }

  const { nextConfig, result } = applyProxySettings(settings.data, port);
  writeSettings(settingsPath, nextConfig);
  return result;
}

function removeProxy(settingsPath: string): RemoveResult {
  if (!fs.existsSync(settingsPath)) {
    return { updated: false, removedProxy: false, removedCert: false };
  }

  const settings = readSettings(settingsPath);
  if (!settings.ok) {
    throw new Error(settings.reason);
  }

  const { nextConfig, result } = removeProxySettings(settings.data);
  writeSettings(settingsPath, nextConfig);
  return result;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export function install(args: string[]): number {
  let port: number;
  try {
    port = getPort(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  log("Installing dotmask proxy...\n");

  // 1. Start proxy daemon (it will generate CA cert on first start if missing)
  log("Starting proxy daemon...");
  installDaemon(port);
  ok("Proxy daemon registered with launchd");

  // 2. Wait briefly for server to start and generate CA
  let waited = 0;
  while (!certExists() && waited < 5000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    waited += 500;
  }

  // 3. Install CA cert
  if (!certExists()) {
    warn("CA cert not yet generated — run `dotmask doctor` after a moment");
  } else if (isCertTrusted()) {
    ok("CA cert already trusted");
  } else {
    log("\nInstalling CA certificate (you may see a macOS password prompt)...");
    if (installCert()) {
      ok("CA cert installed and trusted");
    } else {
      warn("CA cert install may have failed — run `dotmask doctor` to verify");
    }
  }

  // 4. Inject HTTPS_PROXY into Claude Code settings
  let injectResult: InjectResult;
  try {
    injectResult = injectProxy(CLAUDE_SETTINGS, port);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    console.log("\n  Fix ~/.claude/settings.json and run dotmask install again.\n");
    return 1;
  }

  if (injectResult.proxyManaged || injectResult.certManaged) {
    ok("Claude Code settings updated");
  }
  for (const message of injectResult.warnings) {
    warn(message);
  }

  console.log("\n  " + c.bold("dotmask proxy is active:"));
  console.log(`    ${c.green("✓")}  Listening on ${c.cyan(`localhost:${port}`)}`);
  console.log(`    ${c.green("✓")}  Intercepts: Anthropic, OpenAI, OpenRouter`);
  console.log(`    ${c.green("✓")}  Auto-starts at login via launchd`);
  if (injectResult.proxyManaged) {
    console.log(`    ${c.green("✓")}  HTTPS_PROXY set for Claude Code`);
  } else {
    console.log(`    ${c.yellow("•")}  Claude Code keeps existing HTTPS_PROXY`);
  }
  if (!injectResult.certManaged) {
    console.log(`    ${c.yellow("•")}  Claude Code keeps existing NODE_EXTRA_CA_CERTS`);
  }
  console.log("\n  Restart Claude Code to activate.\n");
  return 0;
}

export function uninstall(_args: string[]): number {
  log("Removing dotmask proxy...\n");
  let hadError = false;

  try {
    uninstallDaemon();
    ok("Proxy daemon removed");
  } catch (err) {
    hadError = true;
    error(err instanceof Error ? err.message : String(err));
  }

  try {
    uninstallCert();
    ok("CA cert removed from Keychain");
  } catch (err) {
    hadError = true;
    error(err instanceof Error ? err.message : String(err));
  }

  try {
    const removed = removeProxy(CLAUDE_SETTINGS);
    if (removed.removedProxy || removed.removedCert) {
      ok("Removed dotmask-managed Claude Code settings");
    } else {
      warn("No dotmask-managed Claude Code settings were removed");
    }
  } catch (err) {
    hadError = true;
    error(err instanceof Error ? err.message : String(err));
  }

  console.log("\n  Restart Claude Code to deactivate.\n");
  return hadError ? 1 : 0;
}

export function status(): number {
  console.log(`\n  ${c.bold("dotmask proxy status")}\n`);

  const running = isDaemonRunning();
  const loaded = isDaemonLoaded();
  const trusted = isCertTrusted();
  const certOk = certExists();

  console.log(
    loaded
      ? `  ${c.green("●")}  Proxy daemon: ${running ? c.green("RUNNING") : c.yellow("loaded, not running")}`
      : `  ${c.dim("○")}  Proxy daemon: ${c.dim("not installed")}`
  );
  console.log(
    certOk
      ? `  ${c.green("●")}  CA cert: exists at ${CA_CERT_PATH}`
      : `  ${c.yellow("○")}  CA cert: ${c.yellow("not generated yet")}`
  );
  console.log(
    trusted
      ? `  ${c.green("●")}  CA cert: ${c.green("trusted by macOS")}`
      : `  ${c.yellow("○")}  CA cert: ${c.yellow("not trusted (run dotmask install)")}`
  );

  // Check Claude Code settings
  const settings = readSettings(CLAUDE_SETTINGS);
  if (!settings.ok) {
    console.log(`  ${c.red("●")}  Claude Code settings: ${c.red(settings.reason)}`);
    console.log("");
    return 0;
  }

  const port = resolveManagedPort(settings.data);
  const state = getProxyConfigState(settings.data, port);
  if (state.usesDotmaskProxy) {
    console.log(`  ${c.green("●")}  Claude Code: ${c.green("HTTPS_PROXY set for dotmask")} (${state.env["HTTPS_PROXY"]})`);
  } else if (state.hasConflictingProxy) {
    console.log(`  ${c.yellow("●")}  Claude Code: ${c.yellow("using another HTTPS_PROXY")} (${state.env["HTTPS_PROXY"]})`);
  } else {
    console.log(`  ${c.dim("○")}  Claude Code: ${c.dim("HTTPS_PROXY not set")}`);
  }

  if (state.usesDotmaskCert) {
    console.log(`  ${c.green("●")}  Claude Code: ${c.green("NODE_EXTRA_CA_CERTS set for dotmask")} (${state.env["NODE_EXTRA_CA_CERTS"]})`);
  } else if (state.hasConflictingCert) {
    console.log(`  ${c.yellow("●")}  Claude Code: ${c.yellow("using another NODE_EXTRA_CA_CERTS")} (${state.env["NODE_EXTRA_CA_CERTS"]})`);
  } else {
    console.log(`  ${c.dim("○")}  Claude Code: ${c.dim("NODE_EXTRA_CA_CERTS not set")}`);
  }

  console.log("");
  return 0;
}

export function doctor(): number {
  console.log(`\n  ${c.bold("dotmask doctor")}\n`);

  const settings = readSettings(CLAUDE_SETTINGS);
  const port = settings.ok ? resolveManagedPort(settings.data) : DEFAULT_PORT;
  const checks = buildDoctorChecks(settings, port, {
    daemonLoaded: isDaemonLoaded(),
    daemonRunning: isDaemonRunning(),
    certExists: certExists(),
    certTrusted: isCertTrusted(),
  });

  for (const [label, ok_, hint] of checks) {
    console.log(
      ok_
        ? `  ${c.green("✓")}  ${label}`
        : `  ${c.red("✗")}  ${label}  ${c.dim("→ " + hint)}`
    );
  }
  console.log("");
  return 0;
}
