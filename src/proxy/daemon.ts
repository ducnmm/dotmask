import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOTMASK_DIR, CA_DIR } from "./cert.js";

const LABEL = "com.dotmask.proxy";
const PLIST_PATH = path.join(
  os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`
);
const LOG_PATH = path.join(DOTMASK_DIR, "proxy.log");
const ERR_PATH = path.join(DOTMASK_DIR, "proxy.err.log");

// Path to the compiled proxy server entry point
function proxyBinPath(): string {
  const distDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", ".."
  );
  return path.join(distDir, "dist", "proxy", "server.js");
}

function nodeBin(): string {
  return process.execPath; // use same node that runs dotmask
}

/** Build the launchd plist XML content. */
function buildPlist(port: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin()}</string>
    <string>${proxyBinPath()}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOTMASK_CA_DIR</key>
    <string>${CA_DIR}</string>
    <key>DOTMASK_DEBUG</key>
    <string>0</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_PATH}</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
`;
}

/** Register and start the launchd agent. */
export function installDaemon(port: number): void {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(DOTMASK_DIR, { recursive: true });

  if (isDaemonLoaded()) {
    execFileSync("launchctl", ["unload", PLIST_PATH], { stdio: "pipe" });
  }

  fs.writeFileSync(PLIST_PATH, buildPlist(port), "utf8");
  execFileSync("launchctl", ["load", "-w", PLIST_PATH], { stdio: "pipe" });
}

/** Unload and remove the launchd agent. */
export function uninstallDaemon(): void {
  if (fs.existsSync(PLIST_PATH)) {
    try {
      execFileSync("launchctl", ["unload", PLIST_PATH], { stdio: "pipe" });
    } catch { /* already unloaded */ }
    fs.rmSync(PLIST_PATH, { force: true });
  }
}

/** Check if the launchd agent is loaded. */
export function isDaemonLoaded(): boolean {
  try {
    const result = spawnSync("launchctl", ["list", LABEL], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Check if the proxy process is actually running. */
export function isDaemonRunning(): boolean {
  if (!isDaemonLoaded()) return false;
  try {
    const result = spawnSync("launchctl", ["list", LABEL], { encoding: "utf8" });
    // launchctl list <label> outputs a property-list dict with "PID" key when running
    return result.status === 0 && result.stdout.includes('"PID"');
  } catch {
    return false;
  }
}

export function getDaemonPort(): number | null {
  if (!fs.existsSync(PLIST_PATH)) return null;

  try {
    const plist = fs.readFileSync(PLIST_PATH, "utf8");
    const match = /<string>--port<\/string>\s*<string>(\d+)<\/string>/.exec(plist);
    if (!match) return null;

    const port = Number.parseInt(match[1], 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}
