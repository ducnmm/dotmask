import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok, warn, log, error, c } from "../utils.js";
import { CA_CERT_PATH, certExists, isCertTrusted, installCert, uninstallCert } from "../proxy/cert.js";
import { installDaemon, uninstallDaemon, isDaemonLoaded, isDaemonRunning } from "../proxy/daemon.js";

const DEFAULT_PORT = 18787;
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

function getPort(args: string[]): number {
  const idx = args.indexOf("--port");
  return idx >= 0 ? parseInt(args[idx + 1]) : DEFAULT_PORT;
}

// ── settings.json helpers ─────────────────────────────────────────────────────

function readSettings(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return {}; }
}

function writeSettings(p: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function injectProxy(settingsPath: string, port: number): void {
  const cfg = readSettings(settingsPath);
  const env = ((cfg.env as Record<string, unknown>) ?? {});
  env["HTTPS_PROXY"] = `http://localhost:${port}`;
  env["NODE_EXTRA_CA_CERTS"] = CA_CERT_PATH;
  cfg.env = env;
  writeSettings(settingsPath, cfg);
}

function removeProxy(settingsPath: string): void {
  if (!fs.existsSync(settingsPath)) return;
  const cfg = readSettings(settingsPath);
  if (cfg.env && typeof cfg.env === "object") {
    const env = cfg.env as Record<string, unknown>;
    delete env["HTTPS_PROXY"];
    delete env["NODE_EXTRA_CA_CERTS"];
    cfg.env = env;
  }
  writeSettings(settingsPath, cfg);
}

// ── Commands ──────────────────────────────────────────────────────────────────

export function install(args: string[]): void {
  const port = getPort(args);
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
  injectProxy(CLAUDE_SETTINGS, port);
  ok(`HTTPS_PROXY injected into ~/.claude/settings.json`);

  console.log("\n  " + c.bold("dotmask proxy is active:"));
  console.log(`    ${c.green("✓")}  Listening on ${c.cyan(`localhost:${port}`)}`);
  console.log(`    ${c.green("✓")}  Intercepts: Anthropic, OpenAI, OpenRouter`);
  console.log(`    ${c.green("✓")}  Auto-starts at login via launchd`);
  console.log(`    ${c.green("✓")}  HTTPS_PROXY set for Claude Code`);
  console.log("\n  Restart Claude Code to activate.\n");
}

export function uninstall(_args: string[]): void {
  log("Removing dotmask proxy...\n");

  uninstallDaemon();
  ok("Proxy daemon removed");

  uninstallCert();
  ok("CA cert removed from Keychain");

  removeProxy(CLAUDE_SETTINGS);
  ok("HTTPS_PROXY removed from ~/.claude/settings.json");

  console.log("\n  Restart Claude Code to deactivate.\n");
}

export function status(): void {
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
  const cfg = readSettings(CLAUDE_SETTINGS);
  const env = (cfg.env as Record<string, unknown>) ?? {};
  const proxySet = typeof env["HTTPS_PROXY"] === "string";
  console.log(
    proxySet
      ? `  ${c.green("●")}  Claude Code: ${c.green("HTTPS_PROXY configured")} (${env["HTTPS_PROXY"]})`
      : `  ${c.dim("○")}  Claude Code: ${c.dim("HTTPS_PROXY not set")}`
  );

  console.log("");
}

export function doctor(): void {
  console.log(`\n  ${c.bold("dotmask doctor")}\n`);

  const checks: Array<[string, boolean, string]> = [
    ["Proxy daemon loaded", isDaemonLoaded(), "Run dotmask install"],
    ["Proxy daemon running", isDaemonRunning(), "Run dotmask install or check ~/.dotmask/proxy.err.log"],
    ["CA cert exists", certExists(), "Restart proxy — it generates CA on first run"],
    ["CA cert trusted", isCertTrusted(), "Run dotmask install (triggers macOS trust dialog)"],
    ["Claude Code configured", (() => {
      const cfg = readSettings(CLAUDE_SETTINGS);
      return typeof ((cfg.env as Record<string, unknown>)?.["HTTPS_PROXY"]) === "string";
    })(), "Run dotmask install"],
  ];

  for (const [label, ok_, hint] of checks) {
    console.log(
      ok_
        ? `  ${c.green("✓")}  ${label}`
        : `  ${c.red("✗")}  ${label}  ${c.dim("→ " + hint)}`
    );
  }
  console.log("");
}
