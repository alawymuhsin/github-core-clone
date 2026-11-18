// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, plain JSON answers.
// Speaks revision 2026-07-28 through server/discover, and the legacy
// initialize handshake for older clients. Tools act on the same Store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, readBody, sendJson } from './http-util.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

function toolResult(id: unknown, text: string, structured?: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (structured !== undefined) result.structuredContent = structured;
  return { jsonrpc: '2.0', id, result };
}

function toolError(id: unknown, text: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
  };
}

/** Run one tool against the store. Throws an Error carrying the tool failure. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { text: string; structured?: unknown } {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = owner !== '' && repoName !== '' ? store.getRepo(owner, repoName) : undefined;

  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') throw new Error('name is required');
      if (store.getRepo(VIEWER.login, repoNameArg)) throw new Error('Repository already exists');
      const created = store.createRepo(VIEWER.login, repoNameArg, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      })!;
      const out = repoJson(created);
      return { text: JSON.stringify(out), structured: out };
    }
    case 'get_repo': {
      if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
      const out = repoJson(repo);
      return { text: JSON.stringify(out), structured: out };
    }
    case 'create_issue': {
      if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') throw new Error('title is required');
      const created = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      if ('error' in created) throw new Error(created.error);
      const out = {
        id: created.issue.id,
        number: created.issue.number,
        title: created.issue.title,
        body: created.issue.body,
        state: created.issue.state,
        full_name: `${repo.owner}/${repo.name}`,
      };
      return { text: JSON.stringify(out), structured: out };
    }
    case 'list_issues': {
      if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
      const out = list.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      }));
      return { text: JSON.stringify(out), structured: out };
    }
    case 'create_pull_request': {
      if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (title === '' || head === '') throw new Error('title and head are required');
      const created = store.createPull(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      if ('error' in created) throw new Error(created.error);
      const out = {
        id: created.pull.id,
        number: created.pull.number,
        title: created.pull.title,
        body: created.pull.body,
        state: created.pull.state,
        head: created.pull.headRef,
        base: created.pull.baseRef,
        full_name: `${repo.owner}/${repo.name}`,
      };
      return { text: JSON.stringify(out), structured: out };
    }
    case 'merge_pull_request': {
      if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`Pull request #${number} not found`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) throw new Error(merged.error);
      const out = { number: pull.number, merged: true, sha: merged.sha };
      return { text: JSON.stringify(out), structured: out };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** POST /mcp. Returns true when handled. */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // Auth is checked by app.ts before this point; a missing token never reaches here.

  const body = parseJsonBody(await readBody(req));
  if (body === undefined) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = body.id === undefined ? null : body.id;
  const method = typeof body.method === 'string' ? body.method : '';

  // server/discover (2026-07-28): answered before initialize.
  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: [PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return true;
  }

  if (method === 'initialize') {
    const params = isRecord(body.params) ? body.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return true;
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    return true;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return true;
  }

  if (method === 'tools/call') {
    const params = isRecord(body.params) ? body.params : {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJson(res, 200, toolError(id, `Missing required argument(s): ${missing.join(', ')}`));
      return true;
    }
    try {
      const out = callTool(store, tool.name, args);
      sendJson(res, 200, toolResult(id, out.text, out.structured));
    } catch (error) {
      sendJson(res, 200, toolError(id, error instanceof Error ? error.message : 'Tool call failed'));
    }
    return true;
  }

  // Unknown method.
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
