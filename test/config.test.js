import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addAllowedHost,
  listAllowedHosts,
  loadAllowedHosts,
  removeAllowedHost,
} from "../dist/proxy/config.js";

function makeConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotmask-config-test-"));
  return { dir, file: path.join(dir, "config.json") };
}

describe("proxy config helpers", () => {
  test("loadAllowedHosts creates default config file", () => {
    const { dir, file } = makeConfigPath();

    const hosts = loadAllowedHosts(file);

    assert.equal(fs.existsSync(file), true);
    assert.equal(hosts.has("api.anthropic.com"), true);
    assert.equal(hosts.has("api.openai.com"), true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("addAllowedHost normalizes URL input and deduplicates", () => {
    const { dir, file } = makeConfigPath();

    const first = addAllowedHost("https://Chat.Trollllm.xyz:443/test", file);
    const second = addAllowedHost("chat.trollllm.xyz", file);
    const hosts = listAllowedHosts(file);

    assert.equal(first.host, "chat.trollllm.xyz");
    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.equal(hosts.filter((host) => host === "chat.trollllm.xyz").length, 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("removeAllowedHost removes normalized host", () => {
    const { dir, file } = makeConfigPath();

    addAllowedHost("chat.trollllm.xyz", file);
    const result = removeAllowedHost("chat.trollllm.xyz:443", file);
    const hosts = listAllowedHosts(file);

    assert.equal(result.removed, true);
    assert.equal(hosts.includes("chat.trollllm.xyz"), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("addAllowedHost rejects invalid host", () => {
    const { dir, file } = makeConfigPath();

    assert.throws(() => addAllowedHost("not a host value", file), /invalid host/);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
