import { decodeChunked, getCompleteChunkedMessageLength } from "./sse.js";

export interface ParsedHttpRequest {
  requestLine: string;
  headers: Record<string, string>;
  body: Buffer;
  bytesConsumed: number;
}

export function parseCompleteHttpRequest(buffer: Buffer): ParsedHttpRequest | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerText = buffer.toString("latin1", 0, headerEnd);
  const lines = headerText.split("\r\n");
  const requestLine = lines[0] ?? "";
  const headers: Record<string, string> = {};

  for (const line of lines.slice(1)) {
    const idx = line.indexOf(": ");
    if (idx >= 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 2);
  }

  const bodyStart = headerEnd + 4;
  const rawBody = buffer.subarray(bodyStart);
  if (headers["transfer-encoding"]?.includes("chunked")) {
    const chunkedLength = getCompleteChunkedMessageLength(rawBody);
    if (chunkedLength === null) return null;

    const chunkedBody = rawBody.subarray(0, chunkedLength);
    return {
      requestLine,
      headers,
      body: decodeChunked(chunkedBody),
      bytesConsumed: bodyStart + chunkedLength,
    };
  }

  const bodyExpected = Number.parseInt(headers["content-length"] ?? "0", 10) || 0;
  if (rawBody.length < bodyExpected) return null;

  return {
    requestLine,
    headers,
    body: rawBody.subarray(0, bodyExpected),
    bytesConsumed: bodyStart + bodyExpected,
  };
}
