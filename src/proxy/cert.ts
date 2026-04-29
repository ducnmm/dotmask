import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DOTMASK_DIR = path.join(os.homedir(), ".dotmask");
export const CA_DIR = path.join(DOTMASK_DIR, "ca");
export const CA_CERT_PATH = path.join(CA_DIR, "ca.pem");
export const CA_KEY_PATH = path.join(CA_DIR, "ca.key.pem");

const KEYCHAIN_CERT_LABEL = "dotmask-proxy-ca";
const LOGIN_KEYCHAIN_PATH = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");

function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").trim();
}

function extractPemBlocks(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** Check whether the CA cert is already trusted in macOS Keychain. */
export function isCertTrusted(): boolean {
  if (!certExists()) return false;

  try {
    const result = spawnSync("security", [
      "find-certificate", "-c", KEYCHAIN_CERT_LABEL, "-a", "-p",
      LOGIN_KEYCHAIN_PATH,
    ], { encoding: "utf8" });
    if (result.status !== 0) return false;

    const currentCert = normalizePem(fs.readFileSync(CA_CERT_PATH, "utf8"));
    return extractPemBlocks(result.stdout).some((pem) => normalizePem(pem) === currentCert);
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
      "-k", LOGIN_KEYCHAIN_PATH,
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
      LOGIN_KEYCHAIN_PATH,
    ], { stdio: "pipe" });
  } catch { /* already removed */ }
}
