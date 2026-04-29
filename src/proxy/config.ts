import fs from "node:fs";
import path from "node:path";
import { DOTMASK_DIR } from "./cert.js";
import { AI_DOMAINS } from "./masker.js";

export const CONFIG_PATH = path.join(DOTMASK_DIR, "config.json");
const DEFAULT_ALLOWED_HOSTS = [...AI_DOMAINS];

interface DotmaskConfig {
  allowedHosts?: unknown;
}

type ConfigReadResult =
  | { ok: true; data: { allowedHosts: string[] } }
  | { ok: false; reason: string };

export function normalizeHost(host: string): string {
  return host.trim().replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

function defaultConfig(): { allowedHosts: string[] } {
  return { allowedHosts: [...DEFAULT_ALLOWED_HOSTS] };
}

function normalizeStoredHosts(hosts: unknown[]): string[] {
  return Array.from(new Set(
    hosts
      .filter((host): host is string => typeof host === "string")
      .map(normalizeHost)
      .filter(Boolean),
  ));
}

export function parseHost(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error("host is required");
  }

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const host = normalizeHost(url.hostname);
    if (!host) throw new Error("missing hostname");
    return host;
  } catch {
    const host = normalizeHost(value);
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
      throw new Error(`invalid host: ${input}`);
    }
    return host;
  }
}

export function readAllowedHostsConfig(configPath: string = CONFIG_PATH): ConfigReadResult {
  if (!fs.existsSync(configPath)) {
    return { ok: true, data: defaultConfig() };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as DotmaskConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `${configPath} must contain a JSON object` };
    }
    if (!Array.isArray(parsed.allowedHosts)) {
      return { ok: false, reason: `${configPath} must contain an allowedHosts array` };
    }

    return {
      ok: true,
      data: {
        allowedHosts: normalizeStoredHosts(parsed.allowedHosts),
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function writeAllowedHostsConfig(hosts: string[], configPath: string = CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ allowedHosts: normalizeStoredHosts(hosts) }, null, 2) + "\n",
    "utf8",
  );
}

export function loadAllowedHosts(configPath: string = CONFIG_PATH): Set<string> {
  if (!fs.existsSync(configPath)) {
    writeAllowedHostsConfig(DEFAULT_ALLOWED_HOSTS, configPath);
  }

  const config = readAllowedHostsConfig(configPath);
  if (!config.ok) {
    console.error(`[dotmask] ${config.reason}; using defaults`);
    return new Set(DEFAULT_ALLOWED_HOSTS);
  }

  return new Set(config.data.allowedHosts);
}

export function listAllowedHosts(configPath: string = CONFIG_PATH): string[] {
  const config = readAllowedHostsConfig(configPath);
  if (!config.ok) {
    throw new Error(config.reason);
  }
  return config.data.allowedHosts;
}

export function addAllowedHost(host: string, configPath: string = CONFIG_PATH): {
  host: string;
  added: boolean;
  hosts: string[];
} {
  const normalizedHost = parseHost(host);
  const hosts = listAllowedHosts(configPath);
  const added = !hosts.includes(normalizedHost);
  const nextHosts = added ? [...hosts, normalizedHost] : hosts;
  writeAllowedHostsConfig(nextHosts, configPath);
  return { host: normalizedHost, added, hosts: nextHosts };
}

export function removeAllowedHost(host: string, configPath: string = CONFIG_PATH): {
  host: string;
  removed: boolean;
  hosts: string[];
} {
  const normalizedHost = parseHost(host);
  const hosts = listAllowedHosts(configPath);
  const nextHosts = hosts.filter((value) => value !== normalizedHost);
  const removed = nextHosts.length !== hosts.length;
  writeAllowedHostsConfig(nextHosts, configPath);
  return { host: normalizedHost, removed, hosts: nextHosts };
}
