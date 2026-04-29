import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCompleteHttpRequest } from "../dist/proxy/http.js";

describe("parseCompleteHttpRequest", () => {
  test("parses content-length request with UTF-8 body without corruption", () => {
    const json = JSON.stringify({ text: "xin chao 👋 你好" });
    const body = Buffer.from(json, "utf8");
    const request = Buffer.concat([
      Buffer.from(
        `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
        "latin1",
      ),
      body,
    ]);

    const parsed = parseCompleteHttpRequest(request);
    assert.ok(parsed);
    assert.equal(parsed.requestLine, "POST /v1/messages HTTP/1.1");
    assert.equal(parsed.headers.host, "api.anthropic.com");
    assert.equal(parsed.body.toString("utf8"), json);
    assert.equal(parsed.bytesConsumed, request.length);
  });

  test("returns null for incomplete content-length body", () => {
    const partial = Buffer.from(
      "POST / HTTP/1.1\r\nHost: example.com\r\nContent-Length: 10\r\n\r\nabc",
      "latin1",
    );

    assert.equal(parseCompleteHttpRequest(partial), null);
  });

  test("parses complete chunked request body", () => {
    const chunkedBody = Buffer.from("d\r\nhello, world!\r\n0\r\n\r\n", "latin1");
    const request = Buffer.concat([
      Buffer.from(
        "POST /chunked HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n",
        "latin1",
      ),
      chunkedBody,
    ]);

    const parsed = parseCompleteHttpRequest(request);
    assert.ok(parsed);
    assert.equal(parsed.body.toString("utf8"), "hello, world!");
    assert.equal(parsed.bytesConsumed, request.length);
  });

  test("returns null for incomplete chunked request body", () => {
    const partial = Buffer.concat([
      Buffer.from(
        "POST /chunked HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n",
        "latin1",
      ),
      Buffer.from("5\r\nhello\r\n0\r\n", "latin1"),
    ]);

    assert.equal(parseCompleteHttpRequest(partial), null);
  });

  test("reports bytes consumed so pipelined requests can be preserved", () => {
    const first = Buffer.from("GET /one HTTP/1.1\r\nHost: example.com\r\n\r\n", "latin1");
    const second = Buffer.from("GET /two HTTP/1.1\r\nHost: example.com\r\n\r\n", "latin1");
    const combined = Buffer.concat([first, second]);

    const parsed = parseCompleteHttpRequest(combined);
    assert.ok(parsed);
    assert.equal(parsed.requestLine, "GET /one HTTP/1.1");
    assert.equal(parsed.bytesConsumed, first.length);
    assert.equal(combined.subarray(parsed.bytesConsumed).toString("latin1"), second.toString("latin1"));
  });
});
