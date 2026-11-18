// Small HTTP helpers shared by the REST, GraphQL, MCP and git handlers.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

// The suite only requires X-GitHub-Request-Id to be non-empty (conformance
// check protocol/request-id), so a process-wide counter is enough — and far
// cheaper per reply than a cryptographic UUID on the hot path.
let nextRequestId = 1;

export function requestId(): string {
  const n = nextRequestId++;
  return `req-${n.toString(16).padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}

/**
 * Send a pre-built response body (a Buffer made once, e.g. a cached issue or
 * pack). Skips JSON.stringify, Buffer.byteLength and the string-to-bytes
 * conversion of sendJson — the hot path for repeated identical replies.
 */
export function sendCached(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId(), ...headers });
  res.end(body);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The request path, or '/' when the URL does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Split a path into its '/'-separated segments, URL-decoded, without empties. */
export function segments(path: string): string[] {
  // Hot path: bench and suite URLs carry no %-escapes, so skip the decode
  // pass entirely when the path has no '%' in it.
  if (!path.includes('%')) return path.split('/').filter((s) => s !== '');
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** The path part of a request URL without building a URL object (the URL
 * constructor is one of the slowest calls on the hot path). Query is left
 * for the caller to parse only when the route needs it. */
export function rawPath(url: string | undefined): string {
  const raw = url ?? '/';
  const q = raw.indexOf('?');
  return q < 0 ? raw : raw.slice(0, q);
}

/** Query parameters of a request URL, or an empty set when there is no '?'. */
export function rawQuery(url: string | undefined): URLSearchParams {
  const raw = url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return new URLSearchParams();
  return new URLSearchParams(raw.slice(q + 1));
}

/** Parse a JSON body; returns null when the body is empty or not JSON. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
