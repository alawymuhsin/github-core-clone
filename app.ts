// HTTP server: routes /healthz, /api/v3, /api/graphql, /mcp and the git smart
// HTTP endpoints onto the Store. Every reply is JSON (never HTML) and carries
// X-GitHub-Request-Id; an unknown route is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './lib/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/git-http.ts';
import { sendJson, segments } from './lib/http-util.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { Store } from './lib/store.ts';

function authOk(req: IncomingMessage): boolean {
  const configured = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  if (configured) return header.slice('Bearer '.length) === configured;
  // No token configured (local development): any non-empty bearer is accepted.
  return header.length > 'Bearer '.length;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const seg = segments(path);

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // API root and meta are public.
      if (path.startsWith('/api/v3')) {
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta')) {
          await handleRest(store, req, res, path, url.searchParams);
          return;
        }
        if (!authOk(req)) {
          unauthorized(res);
          return;
        }
        await handleRest(store, req, res, path, url.searchParams);
        return;
      }

      if (path === '/api/graphql') {
        if (!authOk(req)) {
          unauthorized(res);
          return;
        }
        await handleGraphQL(store, req, res);
        return;
      }

      if (path === '/mcp') {
        if (method === 'POST' && !authOk(req)) {
          unauthorized(res);
          return;
        }
        await handleMcp(store, req, res);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs | /git-upload-pack | /git-receive-pack
      if (seg.length >= 3 && seg[1]!.endsWith('.git')) {
        const owner = seg[0]!;
        const repo = seg[1]!.slice(0, -4);
        const service = seg[2];
        if (service === 'info' && seg[3] === 'refs' && method === 'GET') {
          if (!authOk(req)) {
            unauthorized(res);
            return;
          }
          const serviceParam = url.searchParams.get('service') ?? '';
          if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          handleInfoRefs(store, owner, repo, serviceParam, req, res);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          if (!authOk(req)) {
            unauthorized(res);
            return;
          }
          await handleUploadPack(store, owner, repo, req, res);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          if (!authOk(req)) {
            unauthorized(res);
            return;
          }
          await handleReceivePack(store, owner, repo, req, res);
          return;
        }
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (error) {
      // A handler must never crash the server: answer a JSON 500 and stay up.
      try {
        sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      } catch {
        // The response is already gone; nothing more to do.
      }
    }
  });

  // The store rides on the server so tests can reach it without a second export.
  (server as unknown as { store: Store }).store = store;
  return server;
}
