/**
 * Unit tests for SSE handling — extracted pure functions from server.ts
 * Run: node --test test/sse.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decodeChunked,
  stripChunkSizeLines,
  rawBytesHaveTerminal,
  reassembleField,
  unmaskSseFragments,
  getCompleteChunkedMessageLength,
  IncrementalChunkedBodyParser,
  SseEventBuffer,
  encodeChunkedPayload,
  TERMINAL_CHUNK,
} from "../dist/proxy/sse.js";
import { makeFake, unmaskText } from "../dist/proxy/masker.js";

// ── Helper: build a fake→real map from a real key ────────────────────────────
function buildMap(realKey) {
  const fake = makeFake(realKey);
  return { fake, real: realKey, fakeToReal: new Map([[fake, realKey]]) };
}

function fieldValues(text, fieldName) {
  const re = new RegExp(`"${fieldName}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
  return [...text.matchAll(re)].map((m) => JSON.parse('"' + m[1] + '"'));
}

// ── stripChunkSizeLines ──────────────────────────────────────────────────────

describe("stripChunkSizeLines", () => {
  test("removes hex chunk-size line before SSE event", () => {
    const input = '1e\r\ndata: {"type":"ping"}\r\n\r\n';
    const { stripped } = stripChunkSizeLines(input);
    assert.ok(stripped.includes('data: {"type":"ping"}'));
    assert.ok(!stripped.match(/^1e$/m));
  });

  test("handles multiple chunk-size lines in sequence", () => {
    const input =
      '1a\r\ndata: {"type":"event1"}\r\n\r\n' +
      '1b\r\ndata: {"type":"event2"}\r\n\r\n';
    const { stripped } = stripChunkSizeLines(input);
    assert.ok(stripped.includes("event1"));
    assert.ok(stripped.includes("event2"));
    assert.ok(!stripped.match(/^1[ab]$/m));
  });

  test("strips chunk extension (semicolon suffix)", () => {
    const input = 'a3;ext=foo\r\ndata: {"ok":true}\r\n\r\n';
    const { stripped } = stripChunkSizeLines(input);
    assert.ok(stripped.includes('data: {"ok":true}'));
    assert.ok(!stripped.includes("ext=foo"));
  });

  test("terminal zero-chunk sets hasTerminal", () => {
    const input = '0\r\n\r\n';
    const { hasTerminal } = stripChunkSizeLines(input);
    assert.ok(hasTerminal);
  });

  test("non-terminal input does not set hasTerminal", () => {
    const input = '1a\r\ndata: {"type":"ping"}\r\n\r\n';
    const { hasTerminal } = stripChunkSizeLines(input);
    assert.ok(!hasTerminal);
  });

  test("data lines containing hex-like content are preserved", () => {
    // "deadbeef" is valid hex but appears inside a data: line, not as a standalone chunk-size
    const input = 'data: {"partial_json":"deadbeef"}\n\n';
    const { stripped } = stripChunkSizeLines(input);
    assert.ok(stripped.includes("deadbeef"));
  });

  test("LF-only input passes through unchanged", () => {
    const input = 'data: {"type":"ping"}\n\n';
    const { stripped } = stripChunkSizeLines(input);
    assert.equal(stripped, input);
  });

  test("mixed CRLF and LF", () => {
    const input = '1a\r\ndata: event1\r\n\ndata: event2\n\n';
    const { stripped } = stripChunkSizeLines(input);
    assert.ok(stripped.includes("data: event1"));
    assert.ok(stripped.includes("data: event2"));
    assert.ok(!stripped.match(/^1a$/m));
  });
});

// ── rawBytesHaveTerminal ─────────────────────────────────────────────────────

describe("rawBytesHaveTerminal", () => {
  test("detects 0\\r\\n\\r\\n at end of buffer", () => {
    const buf = Buffer.from("some data\r\n0\r\n\r\n");
    assert.ok(rawBytesHaveTerminal(buf));
  });

  test("detects 0\\r\\n\\r\\n in standalone packet", () => {
    const buf = Buffer.from("0\r\n\r\n");
    assert.ok(rawBytesHaveTerminal(buf));
  });

  test("does NOT match hex 10 (decimal 16)", () => {
    const buf = Buffer.from("10\r\n\r\n");
    assert.ok(!rawBytesHaveTerminal(buf));
  });

  test("empty buffer returns false", () => {
    assert.ok(!rawBytesHaveTerminal(Buffer.alloc(0)));
  });

  test("buffer shorter than 5 bytes returns false", () => {
    assert.ok(!rawBytesHaveTerminal(Buffer.from("0\r\n\r")));
    assert.ok(!rawBytesHaveTerminal(Buffer.from("ab")));
  });
});

// ── reassembleField ──────────────────────────────────────────────────────────

describe("reassembleField", () => {
  test("reassembles partial_json split across two fragments", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);
    const part1 = fake.slice(0, half);
    const part2 = fake.slice(half);

    const input =
      `data: {"delta":{"type":"input_json_delta","partial_json":"${part1}"}}\n\n` +
      `data: {"delta":{"type":"input_json_delta","partial_json":"${part2}"}}\n\n`;

    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.ok(!result.includes(fake), "fake key should be replaced");
    // Verify the real key parts are distributed across fragments
    const reExtract = /"partial_json":"([^"]*)"/g;
    let m;
    let reconstructed = "";
    while ((m = reExtract.exec(result)) !== null) {
      reconstructed += m[1];
    }
    assert.equal(reconstructed, real);
  });

  test("reassembles key split into three fragments", () => {
    const real = "sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const p1 = fake.slice(0, 10);
    const p2 = fake.slice(10, 25);
    const p3 = fake.slice(25);

    const input =
      `{"partial_json":"${p1}"}` + "\n" +
      `{"partial_json":"${p2}"}` + "\n" +
      `{"partial_json":"${p3}"}`;

    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.ok(!result.includes(fake));
  });

  test("full key in single fragment — no change needed", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);

    const input = `{"partial_json":"${fake}"}`;
    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.ok(result.includes(real));
  });

  test("no fake key present — passthrough unchanged", () => {
    const fakeToReal = new Map([["sk-proj-fakefakefakefakefake1234", "sk-proj-realrealrealrealreal1234"]]);
    const input = `{"partial_json":"hello world"}`;
    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.equal(result, input);
  });

  test("empty partial_json fragment handled gracefully", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);

    const input =
      `{"partial_json":""}` + "\n" +
      `{"partial_json":"${fake}"}`;

    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.ok(result.includes(real));
    assert.ok(result.includes('"partial_json":""'));
  });

  test("JSON-escaped characters in fragment round-trip correctly", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    // Fragment with escaped newline before partial key
    const input =
      `{"partial_json":"line1\\nline2${fake.slice(0, half)}"}` + "\n" +
      `{"partial_json":"${fake.slice(half)}"}`;

    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.ok(result.includes("line1\\nline2"), "escaped newline preserved");
    assert.ok(!result.includes(fake));
  });

  test("fragment straddles key/non-key boundary", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    const input =
      `{"partial_json":"prefix ${fake.slice(0, half)}"}` + "\n" +
      `{"partial_json":"${fake.slice(half)} suffix"}`;

    const result = reassembleField(input, "partial_json", fakeToReal);
    assert.ok(result.includes("prefix "));
    assert.ok(result.includes(" suffix"));
    assert.ok(!result.includes(fake));
  });

  test("works with text field name", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    const input =
      `{"text":"${fake.slice(0, half)}"}` + "\n" +
      `{"text":"${fake.slice(half)}"}`;

    const result = reassembleField(input, "text", fakeToReal);
    assert.ok(!result.includes(fake));
  });

  test("works with content field name (OpenAI format)", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    const input =
      `{"content":"${fake.slice(0, half)}"}` + "\n" +
      `{"content":"${fake.slice(half)}"}`;

    const result = reassembleField(input, "content", fakeToReal);
    assert.ok(!result.includes(fake));
  });

  test("two interleaved fake keys (two tool calls)", () => {
    const real1 = "sk-proj-aaaabbbbccccddddeeeeffffgggg1234";
    const real2 = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const { fake: fake1, fakeToReal: m1 } = buildMap(real1);
    const { fake: fake2 } = buildMap(real2);
    const fakeToReal = new Map([...m1, [fake2, real2]]);

    // Interleaved: key1 part1, key2 part1, key1 part2, key2 part2
    const half1 = Math.floor(fake1.length / 2);
    const half2 = Math.floor(fake2.length / 2);
    const input =
      `{"partial_json":"${fake1.slice(0, half1)}"}` + "\n" +
      `{"partial_json":"${fake2.slice(0, half2)}"}` + "\n" +
      `{"partial_json":"${fake1.slice(half1)}"}` + "\n" +
      `{"partial_json":"${fake2.slice(half2)}"}`;

    const result = reassembleField(input, "partial_json", fakeToReal);
    const allPartials = [...result.matchAll(/"partial_json":"([^"]*)"/g)].map(m => m[1]);
    assert.equal(allPartials[0] + allPartials[2], real1);
    assert.equal(allPartials[1] + allPartials[3], real2);
  });

  test("interleaved keys with surrounding text are reassembled independently", () => {
    const real1 = "sk-proj-aaaabbbbccccddddeeeeffffgggg1234";
    const real2 = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const { fake: fake1, fakeToReal: m1 } = buildMap(real1);
    const { fake: fake2 } = buildMap(real2);
    const fakeToReal = new Map([...m1, [fake2, real2]]);
    const half1 = Math.floor(fake1.length / 2);
    const half2 = Math.floor(fake2.length / 2);

    const input =
      `{"text":"alpha ${fake1.slice(0, half1)}"}` + "\n" +
      `{"text":"beta ${fake2.slice(0, half2)}"}` + "\n" +
      `{"text":"${fake1.slice(half1)} omega"}` + "\n" +
      `{"text":"${fake2.slice(half2)} delta"}`;

    const result = reassembleField(input, "text", fakeToReal);
    const allTexts = [...result.matchAll(/"text":"([^"]*)"/g)].map(m => JSON.parse('"' + m[1] + '"'));
    assert.equal(allTexts[0] + allTexts[2], `alpha ${real1} omega`);
    assert.equal(allTexts[1] + allTexts[3], `beta ${real2} delta`);
  });
});

// ── unmaskSseFragments ───────────────────────────────────────────────────────

describe("unmaskSseFragments", () => {
  test("simple unmask when full key is in one SSE event", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);

    const input = `data: {"delta":{"text":"your key is ${fake}"}}\n\n`;
    const result = unmaskSseFragments(input, fakeToReal);
    assert.ok(result.includes(real));
    assert.ok(!result.includes(fake));
  });

  test("fragment unmask via partial_json across events", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    const input =
      `data: {"delta":{"partial_json":"${fake.slice(0, half)}"}}\n\n` +
      `data: {"delta":{"partial_json":"${fake.slice(half)}"}}\n\n`;

    const result = unmaskSseFragments(input, fakeToReal);
    const allPartials = [...result.matchAll(/"partial_json":"([^"]*)"/g)].map(m => m[1]);
    const reconstructed = allPartials.join("");
    assert.equal(reconstructed, real);
  });

  test("text_delta fragments unmasked", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const third = Math.floor(fake.length / 3);

    const input =
      `data: {"delta":{"text":"${fake.slice(0, third)}"}}\n\n` +
      `data: {"delta":{"text":"${fake.slice(third, third * 2)}"}}\n\n` +
      `data: {"delta":{"text":"${fake.slice(third * 2)}"}}\n\n`;

    const result = unmaskSseFragments(input, fakeToReal);
    const allTexts = [...result.matchAll(/"text":"([^"]*)"/g)].map(m => m[1]);
    const reconstructed = allTexts.join("");
    assert.equal(reconstructed, real);
  });

  test("content field fragments unmasked (OpenAI format)", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    const input =
      `data: {"choices":[{"delta":{"content":"${fake.slice(0, half)}"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"${fake.slice(half)}"}}]}\n\n`;

    const result = unmaskSseFragments(input, fakeToReal);
    const allContent = [...result.matchAll(/"content":"([^"]*)"/g)].map(m => m[1]);
    const reconstructed = allContent.join("");
    assert.equal(reconstructed, real);
  });

  test("no fake keys — passthrough unchanged", () => {
    const fakeToReal = new Map([["sk-proj-nonexistentfakefakefake1234", "sk-proj-realvalue"]]);
    const input = 'data: {"delta":{"text":"hello world"}}\n\n';
    const result = unmaskSseFragments(input, fakeToReal);
    assert.equal(result, input);
  });

  test("simple unmask does not cause double-replace in reassemble", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);

    // Full key in a single text field — simple unmask handles it,
    // then reassembleField should not try to unmask the now-real value again
    const input = `data: {"delta":{"text":"${fake}"}}\n\n`;
    const result = unmaskSseFragments(input, fakeToReal);
    assert.ok(result.includes(real));
    // Make sure it wasn't double-processed (real key should appear exactly once)
    const count = result.split(real).length - 1;
    assert.equal(count, 1, "real key should appear exactly once");
  });

  test("empty fakeToReal map — passthrough", () => {
    const input = 'data: {"delta":{"text":"some text"}}\n\n';
    const result = unmaskSseFragments(input, new Map());
    assert.equal(result, input);
  });

  test("unicode characters adjacent to fake key", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);

    const input =
      `data: {"delta":{"text":"\\u4f60\\u597d${fake.slice(0, half)}"}}\n\n` +
      `data: {"delta":{"text":"${fake.slice(half)}\\u4e16\\u754c"}}\n\n`;

    const result = unmaskSseFragments(input, fakeToReal);
    assert.ok(!result.includes(fake));
  });

  test("interleaved partial_json fragments are unmasked without mixing streams", () => {
    const real1 = "sk-proj-aaaabbbbccccddddeeeeffffgggg1234";
    const real2 = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const { fake: fake1, fakeToReal: m1 } = buildMap(real1);
    const { fake: fake2 } = buildMap(real2);
    const fakeToReal = new Map([...m1, [fake2, real2]]);
    const half1 = Math.floor(fake1.length / 2);
    const half2 = Math.floor(fake2.length / 2);

    const input =
      `data: {"delta":{"partial_json":"${fake1.slice(0, half1)}"}}\n\n` +
      `data: {"delta":{"partial_json":"${fake2.slice(0, half2)}"}}\n\n` +
      `data: {"delta":{"partial_json":"${fake1.slice(half1)}"}}\n\n` +
      `data: {"delta":{"partial_json":"${fake2.slice(half2)}"}}\n\n`;

    const result = unmaskSseFragments(input, fakeToReal);
    const allPartials = [...result.matchAll(/"partial_json":"([^"]*)"/g)].map(m => m[1]);
    assert.equal(allPartials[0] + allPartials[2], real1);
    assert.equal(allPartials[1] + allPartials[3], real2);
  });
});

// ── Incremental SSE streaming ────────────────────────────────────────────────

describe("SseEventBuffer", () => {
  test("first normal SSE event flushes before terminal chunk", () => {
    const { fakeToReal } = buildMap("sk-proj-abcdefghijklmnopqrstuvwxyz12345");
    const parser = new IncrementalChunkedBodyParser();
    const events = new SseEventBuffer(fakeToReal);
    const event = 'data: {"delta":{"text":"hello"}}\n\n';

    const parsed = parser.push(encodeChunkedPayload(event));
    const flushed = parsed.payloads.flatMap((payload) => events.push(payload));

    assert.equal(parsed.terminal, false);
    assert.deepEqual(flushed, [event]);
  });

  test("full fake token inside one event is unmasked and flushed", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const events = new SseEventBuffer(fakeToReal);
    const event = `data: {"delta":{"text":"your key is ${fake}"}}\n\n`;

    const flushed = events.push(Buffer.from(event));

    assert.equal(flushed.length, 1);
    assert.ok(flushed[0].includes(real));
    assert.ok(!flushed[0].includes(fake));
  });

  test("fake token split across two partial_json events is held until reconstructable", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);
    const events = new SseEventBuffer(fakeToReal);

    const first = `data: {"delta":{"partial_json":"${fake.slice(0, half)}"}}\n\n`;
    const second = `data: {"delta":{"partial_json":"${fake.slice(half)}"}}\n\n`;

    assert.deepEqual(events.push(Buffer.from(first)), []);
    const flushed = events.push(Buffer.from(second));
    const joined = flushed.join("");

    assert.equal(flushed.length, 2);
    assert.ok(!joined.includes(fake));
    assert.equal(fieldValues(joined, "partial_json").join(""), real);
  });

  test("safe events before a split token flush while the split event is held", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);
    const events = new SseEventBuffer(fakeToReal);
    const normal = 'data: {"delta":{"text":"ready"}}\n\n';
    const first = `data: {"delta":{"partial_json":"${fake.slice(0, half)}"}}\n\n`;
    const second = `data: {"delta":{"partial_json":"${fake.slice(half)}"}}\n\n`;

    assert.deepEqual(events.push(Buffer.from(normal + first)), [normal]);
    const flushed = events.push(Buffer.from(second));
    const joined = flushed.join("");

    assert.equal(flushed.length, 2);
    assert.equal(fieldValues(joined, "partial_json").join(""), real);
  });

  test("fake token split across three partial_json events is held only until complete", () => {
    const real = "sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const events = new SseEventBuffer(fakeToReal);
    const firstCut = 10;
    const secondCut = 25;

    const first = `data: {"delta":{"partial_json":"${fake.slice(0, firstCut)}"}}\n\n`;
    const second = `data: {"delta":{"partial_json":"${fake.slice(firstCut, secondCut)}"}}\n\n`;
    const third = `data: {"delta":{"partial_json":"${fake.slice(secondCut)}"}}\n\n`;

    assert.deepEqual(events.push(Buffer.from(first)), []);
    assert.deepEqual(events.push(Buffer.from(second)), []);
    const flushed = events.push(Buffer.from(third));
    const joined = flushed.join("");

    assert.equal(flushed.length, 3);
    assert.ok(!joined.includes(fake));
    assert.equal(fieldValues(joined, "partial_json").join(""), real);
  });

  test("Anthropic-style text fragments unmask incrementally", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);
    const events = new SseEventBuffer(fakeToReal);

    assert.deepEqual(events.push(Buffer.from(`data: {"delta":{"text":"${fake.slice(0, half)}"}}\n\n`)), []);
    const flushed = events.push(Buffer.from(`data: {"delta":{"text":"${fake.slice(half)}"}}\n\n`));
    const joined = flushed.join("");

    assert.equal(fieldValues(joined, "text").join(""), real);
    assert.ok(!joined.includes(fake));
  });

  test("OpenAI-style content fragments unmask incrementally", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const { fake, fakeToReal } = buildMap(real);
    const half = Math.floor(fake.length / 2);
    const events = new SseEventBuffer(fakeToReal);

    assert.deepEqual(events.push(Buffer.from(`data: {"choices":[{"delta":{"content":"${fake.slice(0, half)}"}}]}\n\n`)), []);
    const flushed = events.push(Buffer.from(`data: {"choices":[{"delta":{"content":"${fake.slice(half)}"}}]}\n\n`));
    const joined = flushed.join("");

    assert.equal(fieldValues(joined, "content").join(""), real);
    assert.ok(!joined.includes(fake));
  });

  test("incomplete event remains buffered until delimiter arrives", () => {
    const { fakeToReal } = buildMap("sk-proj-abcdefghijklmnopqrstuvwxyz12345");
    const events = new SseEventBuffer(fakeToReal);
    const partial = 'data: {"delta":{"text":"hello"}}\n';

    assert.deepEqual(events.push(Buffer.from(partial)), []);
    assert.deepEqual(events.push(Buffer.from("\n")), [partial + "\n"]);
  });

  test("chunked SSE output uses valid chunk sizes and terminal chunk", () => {
    const first = 'data: {"delta":{"text":"hello"}}\n\n';
    const second = "data: [DONE]\n\n";
    const output = Buffer.concat([
      encodeChunkedPayload(first),
      encodeChunkedPayload(second),
      TERMINAL_CHUNK,
    ]);

    assert.equal(getCompleteChunkedMessageLength(output), output.length);
    assert.equal(decodeChunked(output).toString("utf8"), first + second);
  });
});

// ── decodeChunked ────────────────────────────────────────────────────────────

describe("decodeChunked", () => {
  test("single chunk decode", () => {
    const input = Buffer.from("5\r\nhello\r\n0\r\n\r\n");
    const result = decodeChunked(input);
    assert.equal(result.toString(), "hello");
  });

  test("multiple chunks concatenated", () => {
    const input = Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    const result = decodeChunked(input);
    assert.equal(result.toString(), "hello world");
  });

  test("chunk extension tolerated (parseInt stops at semicolon)", () => {
    const input = Buffer.from("5;ext=foo\r\nhello\r\n0\r\n\r\n");
    const result = decodeChunked(input);
    assert.equal(result.toString(), "hello");
  });

  test("truncated input does not hang — returns what was decoded", () => {
    const input = Buffer.from("5\r\nhello\r\n3\r\nwor");
    const result = decodeChunked(input);
    // First chunk "hello" is complete, second "wor" is truncated (expected 3 bytes, got 3 but no trailing \r\n)
    // The implementation reads from nextCrLf+2 to nextCrLf+2+len, so it gets "wor" then tries to advance
    // offset to nextCrLf+2+3+2 which is beyond buffer, loop exits
    assert.equal(result.toString(), "hellowor");
  });

  test("empty input returns empty buffer", () => {
    const result = decodeChunked(Buffer.alloc(0));
    assert.equal(result.length, 0);
  });

  test("only terminal chunk", () => {
    const input = Buffer.from("0\r\n\r\n");
    const result = decodeChunked(input);
    assert.equal(result.length, 0);
  });
});

describe("getCompleteChunkedMessageLength", () => {
  test("returns full length for complete chunked message", () => {
    const buf = Buffer.from("5\r\nhello\r\n0\r\n\r\n");
    assert.equal(getCompleteChunkedMessageLength(buf), buf.length);
  });

  test("returns null when terminal chunk is incomplete", () => {
    const buf = Buffer.from("5\r\nhello\r\n0\r\n");
    assert.equal(getCompleteChunkedMessageLength(buf), null);
  });

  test("returns null when terminal chunk is split across packets", () => {
    const partial = Buffer.from("5\r\nhello\r\n0\r");
    const full = Buffer.concat([partial, Buffer.from("\n\r\n")]);
    assert.equal(getCompleteChunkedMessageLength(partial), null);
    assert.equal(getCompleteChunkedMessageLength(full), full.length);
  });

  test("supports trailing headers after terminal chunk", () => {
    const buf = Buffer.from("5\r\nhello\r\n0\r\nX-Test: 1\r\n\r\n");
    assert.equal(getCompleteChunkedMessageLength(buf), buf.length);
  });

  test("does not confuse chunk size 10 with terminal chunk", () => {
    const buf = Buffer.from("10\r\n1234567890abcdef\r\n0\r\n\r\n");
    assert.equal(getCompleteChunkedMessageLength(buf), buf.length);
  });
});
