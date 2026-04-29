import { addAllowedHost, listAllowedHosts, removeAllowedHost } from "../proxy/config.js";
import { getDaemonPort, installDaemon, isDaemonLoaded } from "../proxy/daemon.js";
import { c, dim, error, ok, warn } from "../utils.js";

function reloadDaemonIfNeeded(): void {
  if (!isDaemonLoaded()) {
    dim("proxy daemon is not installed; host changes apply on next dotmask install");
    return;
  }

  const port = getDaemonPort();
  if (port === null) {
    warn("saved host list, but could not determine proxy port to reload automatically");
    return;
  }

  try {
    installDaemon(port);
    ok(`Proxy daemon reloaded on localhost:${port}`);
  } catch (err) {
    warn(`saved host list, but failed to reload proxy daemon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function printHostsList(hosts: string[]): void {
  console.log(`\n  ${c.bold("allowed hosts")}\n`);
  for (const host of hosts) {
    console.log(`  - ${host}`);
  }
  console.log("");
}

export function allow(args: string[]): number {
  const rawHost = args[0];
  if (!rawHost) {
    error("allow requires a host");
    return 1;
  }

  try {
    const result = addAllowedHost(rawHost);
    if (result.added) {
      ok(`Added allowed host: ${result.host}`);
    } else {
      warn(`Host already allowed: ${result.host}`);
    }
    reloadDaemonIfNeeded();
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function disallow(args: string[]): number {
  const rawHost = args[0];
  if (!rawHost) {
    error("disallow requires a host");
    return 1;
  }

  try {
    const result = removeAllowedHost(rawHost);
    if (result.removed) {
      ok(`Removed allowed host: ${result.host}`);
    } else {
      warn(`Host was not in allowlist: ${result.host}`);
    }
    reloadDaemonIfNeeded();
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function hosts(): number {
  try {
    printHostsList(listAllowedHosts());
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
