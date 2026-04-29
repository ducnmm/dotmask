import { StringDecoder } from "node:string_decoder";
import { unmaskText } from "./masker.js";

interface FragmentMatch {
  start: number;
  end: number;
  decoded: string;
}

interface EventFieldMatch {
  eventIndex: number;
  decoded: string;
}

export interface ChunkedParseResult {
  payloads: Buffer[];
  terminal: boolean;
}

export const TERMINAL_CHUNK = Buffer.from("0\r\n\r\n", "ascii");

export function encodeChunkedPayload(payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  return Buffer.concat([
    Buffer.from(`${body.length.toString(16)}\r\n`, "ascii"),
    body,
    Buffer.from("\r\n", "ascii"),
  ]);
}

export class IncrementalChunkedBodyParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ended = false;

  push(chunk: Buffer): ChunkedParseResult {
    if (this.ended) return { payloads: [], terminal: true };

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const payloads: Buffer[] = [];

    while (this.buffer.length > 0) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd === -1) break;

      const sizeLine = this.buffer.toString("ascii", 0, lineEnd).trim();
      const sizeHex = sizeLine.split(";", 1)[0];
      if (!/^[0-9a-fA-F]+$/.test(sizeHex)) {
        throw new Error(`invalid chunk size line: ${sizeLine}`);
      }

      const len = parseInt(sizeHex, 16);
      const payloadStart = lineEnd + 2;

      if (len === 0) {
        let trailerOffset = payloadStart;
        while (true) {
          const trailerEnd = this.buffer.indexOf("\r\n", trailerOffset);
          if (trailerEnd === -1) return { payloads, terminal: false };

          if (trailerEnd === trailerOffset) {
            this.buffer = this.buffer.subarray(trailerEnd + 2);
            this.ended = true;
            return { payloads, terminal: true };
          }

          trailerOffset = trailerEnd + 2;
        }
      }

      const payloadEnd = payloadStart + len;
      if (this.buffer.length < payloadEnd + 2) break;
      if (this.buffer[payloadEnd] !== 0x0d || this.buffer[payloadEnd + 1] !== 0x0a) {
        throw new Error("invalid chunk payload terminator");
      }

      payloads.push(Buffer.from(this.buffer.subarray(payloadStart, payloadEnd)));
      this.buffer = this.buffer.subarray(payloadEnd + 2);
    }

    return { payloads, terminal: false };
  }
}

export class SseEventBuffer {
  private decoder = new StringDecoder("utf8");
  private pendingText = "";
  private events: string[] = [];

  constructor(private readonly fakeToReal: Map<string, string>) {}

  push(payload: Buffer | string): string[] {
    const text = Buffer.isBuffer(payload) ? this.decoder.write(payload) : payload;
    return this.pushText(text);
  }

  finish(): string[] {
    const tail = this.decoder.end();
    if (tail.length > 0) this.pendingText += normalizeSseText(tail);
    if (this.pendingText.length > 0) {
      this.events.push(this.pendingText);
      this.pendingText = "";
    }
    return this.drainEvents(true);
  }

  private pushText(text: string): string[] {
    const parsed = extractCompleteSseEvents(this.pendingText + text);
    this.pendingText = parsed.remaining;
    this.events.push(...parsed.events);
    return this.drainEvents(false);
  }

  private drainEvents(force: boolean): string[] {
    if (this.events.length === 0) return [];

    const flushCount = force
      ? this.events.length
      : getSafeSseEventFlushCount(this.events, this.fakeToReal);
    if (flushCount <= 0) return [];

    const originalCount = this.events.length;
    const unmasked = unmaskSseFragments(this.events.join(""), this.fakeToReal);
    const processedEvents = splitSseEventText(unmasked);

    if (processedEvents.length !== originalCount) {
      if (flushCount === originalCount) {
        this.events = [];
        return unmasked.length > 0 ? [unmasked] : [];
      }
      return [];
    }

    const flushed = processedEvents.slice(0, flushCount);
    this.events = processedEvents.slice(flushCount);
    return flushed;
  }
}

function normalizeSseText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function extractCompleteSseEvents(text: string): { events: string[]; remaining: string } {
  const normalized = normalizeSseText(text);
  const events: string[] = [];
  let start = 0;

  while (true) {
    const sep = normalized.indexOf("\n\n", start);
    if (sep === -1) break;

    const event = normalized.slice(start, sep + 2);
    if (event.trim().length > 0) events.push(event);
    start = sep + 2;
  }

  return { events, remaining: normalized.slice(start) };
}

function splitSseEventText(text: string): string[] {
  const parsed = extractCompleteSseEvents(text);
  if (parsed.remaining.length > 0) parsed.events.push(parsed.remaining);
  return parsed.events;
}

export function decodeChunked(buffer: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nextCrLf = buffer.indexOf("\r\n", offset);
    if (nextCrLf === -1) break;
    const hex = buffer.toString("utf8", offset, nextCrLf).trim();
    const len = parseInt(hex, 16);
    if (isNaN(len)) break;
    if (len === 0) break;
    chunks.push(buffer.subarray(nextCrLf + 2, nextCrLf + 2 + len));
    offset = nextCrLf + 2 + len + 2;
  }
  return Buffer.concat(chunks);
}

export function getCompleteChunkedMessageLength(buffer: Buffer): number | null {
  let offset = 0;

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;

    const sizeLine = buffer.toString("ascii", offset, lineEnd).trim();
    const sizeHex = sizeLine.split(";", 1)[0];
    if (!/^[0-9a-fA-F]+$/.test(sizeHex)) return null;

    const len = parseInt(sizeHex, 16);
    offset = lineEnd + 2;

    if (len === 0) {
      while (true) {
        const trailerStart = offset;
        const trailerEnd = buffer.indexOf("\r\n", offset);
        if (trailerEnd === -1) return null;
        offset = trailerEnd + 2;
        if (trailerEnd === trailerStart) return offset;
      }
    }

    const chunkEnd = offset + len;
    if (buffer.length < chunkEnd + 2) return null;
    if (buffer[chunkEnd] !== 0x0d || buffer[chunkEnd + 1] !== 0x0a) return null;
    offset = chunkEnd + 2;
  }

  return null;
}

export function stripChunkSizeLines(text: string): { stripped: string; hasTerminal: boolean } {
  let hasTerminal = false;
  const stripped = text
    .replace(/\r\n/g, "\n")
    .replace(/^([0-9a-fA-F]+)(?:;[^\n]*)?\n/gm, (_, hex) => {
      if (parseInt(hex, 16) === 0) hasTerminal = true;
      return "";
    });
  return { stripped, hasTerminal };
}

export function rawBytesHaveTerminal(buf: Buffer): boolean {
  for (let i = 0; i <= buf.length - 5; i++) {
    const startsAtLineBoundary = i === 0 || (buf[i - 2] === 0x0d && buf[i - 1] === 0x0a);
    if (!startsAtLineBoundary) continue;
    if (buf[i] === 0x30 && buf[i+1] === 0x0D && buf[i+2] === 0x0A &&
        buf[i+3] === 0x0D && buf[i+4] === 0x0A) {
      return true;
    }
  }
  return false;
}

function collectFieldMatches(src: string, fieldName: string): FragmentMatch[] {
  const frags: FragmentMatch[] = [];
  const prefix = `"${fieldName}":"`;
  const re = new RegExp(`"${fieldName}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const valueStart = m.index + prefix.length;
    let decoded: string;
    try { decoded = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    frags.push({ start: valueStart, end: valueStart + m[1].length, decoded });
  }
  return frags;
}

function replaceMatches(src: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let out = src;
  for (let i = replacements.length - 1; i >= 0; i--) {
    out = out.slice(0, replacements[i].start) + replacements[i].value + out.slice(replacements[i].end);
  }
  return out;
}

function longestFakePrefixSuffix(text: string, fake: string): number {
  const maxLen = Math.min(text.length, fake.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (text.endsWith(fake.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

function collectEventFieldMatches(events: string[], fieldName: string): EventFieldMatch[] {
  const matches: EventFieldMatch[] = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    for (const match of collectFieldMatches(events[eventIndex], fieldName)) {
      matches.push({ eventIndex, decoded: match.decoded });
    }
  }
  return matches;
}

function candidateCompletes(values: EventFieldMatch[], start: number, fake: string): boolean {
  let progress = longestFakePrefixSuffix(values[start].decoded, fake);
  if (progress === 0) return true;

  let sequence = fake.slice(0, progress);
  for (let idx = start + 1; idx < values.length; idx++) {
    const nextSequence = sequence + values[idx].decoded;
    if (nextSequence.startsWith(fake)) return true;

    const nextProgress = longestFakePrefixSuffix(nextSequence, fake);
    if (nextProgress > progress) {
      sequence = nextSequence;
      progress = nextProgress;
    }
  }

  return false;
}

export function getSafeSseEventFlushCount(events: string[], fakeToReal: Map<string, string>): number {
  if (events.length === 0 || fakeToReal.size === 0) return events.length;

  let earliestHold: number | null = null;
  const fakeKeys = [...fakeToReal.keys()].sort((a, b) => b.length - a.length);

  for (const fieldName of ["partial_json", "text", "content"]) {
    const values = collectEventFieldMatches(events, fieldName);
    if (values.length === 0) continue;

    for (const fake of fakeKeys) {
      for (let start = 0; start < values.length; start++) {
        const progress = longestFakePrefixSuffix(values[start].decoded, fake);
        if (progress === 0) continue;
        if (candidateCompletes(values, start, fake)) continue;

        const eventIndex = values[start].eventIndex;
        earliestHold = earliestHold === null ? eventIndex : Math.min(earliestHold, eventIndex);
      }
    }
  }

  return earliestHold === null ? events.length : earliestHold;
}

export function reassembleField(src: string, fieldName: string, fakeToReal: Map<string, string>): string {
  const matches = collectFieldMatches(src, fieldName);
  if (matches.length === 0 || fakeToReal.size === 0) return src;

  const values = matches.map((match) => match.decoded);
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const [fake, real] of [...fakeToReal.entries()].sort((a, b) => b[0].length - a[0].length)) {
    const used = new Set<number>();

    for (let start = 0; start < values.length; start++) {
      if (used.has(start)) continue;

      let sequence = values[start];
      let progress = longestFakePrefixSuffix(sequence, fake);
      let hit = sequence.includes(fake);
      if (!hit && progress === 0) continue;

      const indices = [start];
      for (let idx = start + 1; idx < values.length && !hit; idx++) {
        if (used.has(idx)) continue;

        const nextSequence = sequence + values[idx];
        if (nextSequence.includes(fake)) {
          sequence = nextSequence;
          indices.push(idx);
          hit = true;
          break;
        }

        const nextProgress = longestFakePrefixSuffix(nextSequence, fake);
        if (nextProgress > progress) {
          sequence = nextSequence;
          progress = nextProgress;
          indices.push(idx);
        }
      }

      if (!hit) continue;

      const replaced = sequence.split(fake).join(real);
      let offset = 0;
      for (const idx of indices) {
        const updated = replaced.slice(offset, offset + values[idx].length);
        offset += values[idx].length;
        if (updated === values[idx]) continue;
        values[idx] = updated;
        replacements.push({
          start: matches[idx].start,
          end: matches[idx].end,
          value: JSON.stringify(updated).slice(1, -1),
        });
      }

      for (const idx of indices) {
        used.add(idx);
      }
    }
  }

  if (replacements.length === 0) return src;
  return replaceMatches(src, replacements);
}

export function unmaskSseFragments(text: string, fakeToReal: Map<string, string>): string {
  let result = text;
  const { unmasked: simple, count: simpleCount } = unmaskText(text, fakeToReal);
  if (simpleCount > 0) { result = simple; }

  result = reassembleField(result, "partial_json", fakeToReal);
  result = reassembleField(result, "text", fakeToReal);
  result = reassembleField(result, "content", fakeToReal);

  return result;
}
