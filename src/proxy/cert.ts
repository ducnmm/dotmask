import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DOTMASK_DIR = path.join(os.homedir(), ".dotmask");
export const CA_DIR = path.join(DOTMASK_DIR, "ca");
export const CA_CERT_PATH = path.join(CA_DIR, "ca.pem");
export const CA_KEY_PATH = path.join(CA_DIR, "ca.key.pem");

const KEYCHAIN_CERT_LABEL = "dotmask-proxy-ca";

/** Check whether the CA cert is already trusted in macOS Keychain. */
export function isCertTrusted(): boolean {
  try {
    const result = spawnSync("security", [
      "find-certificate", "-c", KEYCHAIN_CERT_LABEL, "-a",
      path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    ], { encoding: "utf8" });
    return result.status === 0 && result.stdout.includes(KEYCHAIN_CERT_LABEL);
  } catch {
    return false;
  }
}

/** Check whether the CA cert files exist on disk. */
export function certExists(): boolean {
  return fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH);
}

/**
 * Install the CA cert into macOS login Keychain and mark it as trusted.
 * Will trigger a macOS password/Touch ID prompt.
 */
export function installCert(): boolean {
  if (!certExists()) return false;
  try {
    execFileSync("security", [
      "add-trusted-cert",
      "-d",
      "-r", "trustRoot",
      "-k", path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
      CA_CERT_PATH,
    ], { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

/** Remove the dotmask CA cert from macOS Keychain. */
export function uninstallCert(): void {
  try {
    execFileSync("security", [
      "delete-certificate",
      "-c", KEYCHAIN_CERT_LABEL,
      path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    ], { stdio: "pipe" });
  } catch { /* already removed */ }
}
