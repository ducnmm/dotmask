import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyProxySettings,
  buildDoctorChecks,
  dotmaskProxyValue,
  getProxyConfigState,
  readSettings,
  removeProxySettings,
  resolveManagedPort,
} from "../dist/commands/install.js";
import { CA_CERT_PATH } from "../dist/proxy/cert.js";

describe("install settings helpers", () => {
  test("readSettings returns parse error for invalid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotmask-install-test-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{invalid", "utf8");

    const result = readSettings(file);
    assert.equal(result.ok, false);
    assert.match(result.reason, /failed to parse/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("getProxyConfigState detects dotmask-managed config", () => {
    const cfg = {
      env: {
        HTTPS_PROXY: dotmaskProxyValue(18787),
        NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
      },
      dotmask: {
        managedEnv: {
          HTTPS_PROXY: true,
          NODE_EXTRA_CA_CERTS: true,
        },
      },
    };

    const state = getProxyConfigState(cfg, 18787);
    assert.equal(state.usesDotmaskProxy, true);
    assert.equal(state.usesDotmaskCert, true);
    assert.equal(state.hasConflictingProxy, false);
    assert.equal(state.hasConflictingCert, false);
  });

  test("getProxyConfigState detects conflicting proxy and cert", () => {
    const cfg = {
      env: {
        HTTPS_PROXY: "http://corp-proxy:8080",
        NODE_EXTRA_CA_CERTS: "/tmp/custom-ca.pem",
      },
    };

    const state = getProxyConfigState(cfg, 18787);
    assert.equal(state.usesDotmaskProxy, false);
    assert.equal(state.usesDotmaskCert, false);
    assert.equal(state.hasConflictingProxy, true);
    assert.equal(state.hasConflictingCert, true);
  });

  test("applyProxySettings injects dotmask config into empty settings", () => {
    const { nextConfig, result } = applyProxySettings({}, 18787);
    assert.equal(result.updated, true);
    assert.equal(result.proxyManaged, true);
    assert.equal(result.certManaged, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(nextConfig.env.HTTPS_PROXY, dotmaskProxyValue(18787));
    assert.equal(nextConfig.env.NODE_EXTRA_CA_CERTS, CA_CERT_PATH);
    assert.deepEqual(nextConfig.dotmask.managedEnv, {
      HTTPS_PROXY: true,
      NODE_EXTRA_CA_CERTS: true,
    });
    assert.equal(nextConfig.dotmask.port, 18787);
  });

  test("resolveManagedPort uses stored custom port", () => {
    const { nextConfig } = applyProxySettings({}, 19000);
    assert.equal(resolveManagedPort(nextConfig), 19000);
  });

  test("applyProxySettings preserves conflicting user config and warns", () => {
    const cfg = {
      env: {
        HTTPS_PROXY: "http://corp-proxy:8080",
        NODE_EXTRA_CA_CERTS: "/tmp/custom-ca.pem",
      },
    };

    const { nextConfig, result } = applyProxySettings(cfg, 18787);
    assert.equal(result.updated, false);
    assert.equal(result.proxyManaged, false);
    assert.equal(result.certManaged, false);
    assert.equal(result.warnings.length, 2);
    assert.equal(nextConfig.env.HTTPS_PROXY, "http://corp-proxy:8080");
    assert.equal(nextConfig.env.NODE_EXTRA_CA_CERTS, "/tmp/custom-ca.pem");
  });

  test("removeProxySettings removes only dotmask-managed env vars", () => {
    const cfg = {
      env: {
        HTTPS_PROXY: dotmaskProxyValue(18787),
        NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
        FOO: "bar",
      },
      dotmask: {
        port: 18787,
        managedEnv: {
          HTTPS_PROXY: true,
          NODE_EXTRA_CA_CERTS: true,
        },
      },
    };

    const { nextConfig, result } = removeProxySettings(cfg);
    assert.equal(result.updated, true);
    assert.equal(result.removedProxy, true);
    assert.equal(result.removedCert, true);
    assert.equal(nextConfig.env.HTTPS_PROXY, undefined);
    assert.equal(nextConfig.env.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(nextConfig.env.FOO, "bar");
    assert.equal(nextConfig.dotmask, undefined);
  });

  test("removeProxySettings keeps unrelated user config untouched", () => {
    const cfg = {
      env: {
        HTTPS_PROXY: "http://corp-proxy:8080",
        NODE_EXTRA_CA_CERTS: "/tmp/custom-ca.pem",
      },
    };

    const { nextConfig, result } = removeProxySettings(cfg);
    assert.equal(result.updated, false);
    assert.equal(result.removedProxy, false);
    assert.equal(result.removedCert, false);
    assert.equal(nextConfig.env.HTTPS_PROXY, "http://corp-proxy:8080");
    assert.equal(nextConfig.env.NODE_EXTRA_CA_CERTS, "/tmp/custom-ca.pem");
  });

  test("buildDoctorChecks reports parse failure hint", () => {
    const checks = buildDoctorChecks(
      { ok: false, reason: "failed to parse ~/.claude/settings.json" },
      18787,
      {
        daemonLoaded: true,
        daemonRunning: true,
        certExists: true,
        certTrusted: true,
      },
    );

    const settingsReadable = checks.find(([label]) => label === "Claude Code settings readable");
    assert.deepEqual(settingsReadable, [
      "Claude Code settings readable",
      false,
      "Fix ~/.claude/settings.json so it contains valid JSON",
    ]);
  });

  test("buildDoctorChecks reports conflicting proxy hint", () => {
    const checks = buildDoctorChecks(
      {
        ok: true,
        data: {
          env: {
            HTTPS_PROXY: "http://corp-proxy:8080",
            NODE_EXTRA_CA_CERTS: "/tmp/custom-ca.pem",
          },
        },
      },
      18787,
      {
        daemonLoaded: true,
        daemonRunning: true,
        certExists: true,
        certTrusted: true,
      },
    );

    const httpsCheck = checks.find(([label]) => label === "Claude Code HTTPS_PROXY uses dotmask");
    const certCheck = checks.find(([label]) => label === "Claude Code NODE_EXTRA_CA_CERTS uses dotmask");
    assert.equal(httpsCheck[1], false);
    assert.match(httpsCheck[2], /Remove conflicting HTTPS_PROXY/);
    assert.equal(certCheck[1], false);
    assert.match(certCheck[2], /Remove conflicting NODE_EXTRA_CA_CERTS/);
  });

  test("buildDoctorChecks accepts custom dotmask port", () => {
    const checks = buildDoctorChecks(
      {
        ok: true,
        data: applyProxySettings({}, 19000).nextConfig,
      },
      19000,
      {
        daemonLoaded: true,
        daemonRunning: true,
        certExists: true,
        certTrusted: true,
      },
    );

    const httpsCheck = checks.find(([label]) => label === "Claude Code HTTPS_PROXY uses dotmask");
    assert.equal(httpsCheck[1], true);
  });

  test("cli exits non-zero for invalid install port", () => {
    const cliPath = path.resolve("dist", "cli.js");
    const result = spawnSync(process.execPath, [cliPath, "install", "--port", "nope"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid --port value/);
  });
});
