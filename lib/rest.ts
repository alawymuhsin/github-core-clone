// REST v3 under /api/v3: repositories, contents, git refs, issues, pull
// requests. Every reply is application/json with X-GitHub-Request-Id; an
// unknown route is a JSON 404, never HTML.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCommit, hashObject, parseCommit } from './gitobj.ts';
import { isRecord, parseJsonBody, queryOf, readBody, segments, sendJson } from './http-util.ts';
import {
  VIEWER,
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

const OWNER_URL = (repo: Repo): string => `/api/v3/repos/${repo.owner}/${repo.name}`;

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: 'VXNlcjoxMDAw', type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    url: OWNER_URL(repo),
  };
}

function labelJson(repo: Repo, label: { name: string; color: string; description: string }): Record<string, unknown> {
  return {
    id: Math.abs([...label.name].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 7)),
    node_id: `TGFiZWw6${repo.id}:${label.name}`,
    name: label.name,
    color: label.color,
    description: label.description,
    url: `${OWNER_URL(repo)}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => labelJson(repo, l)),
    user: { login: issue.user, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    comments: (repo.issueComments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${OWNER_URL(repo)}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; user: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.owner, repo.name, issueNumber, comment.id),
    body: comment.body,
    user: { login: comment.user, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${OWNER_URL(repo)}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

function pullDiffStats(store: Store, repo: Repo, pull: PullRequest): { additions: number; deletions: number; changed: number } {
  const mb = store.mergeBase(repo, pull.baseSha, pull.headSha);
  const baseTree = mb ? store.commitTree(repo, mb) : null;
  const headTree = store.commitTree(repo, pull.headSha);
  const diff = store.diffTrees(repo, baseTree, headTree);
  let additions = 0;
  let deletions = 0;
  for (const file of diff) {
    const counts = store.lineCounts(repo, file.oldOid, file.newOid);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return { additions, deletions, changed: diff.length };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const baseTip = store.refCommit(repo, `refs/heads/${pull.baseRef}`);
  const headTip = store.refCommit(repo, `refs/heads/${pull.headRef}`);
  const mergeable = pull.state === 'open' && baseTip !== null && headTip !== null ? store.mergeable(repo, baseTip, headTip) : false;
  const stats = pullDiffStats(store, repo, pull);
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user, id: VIEWER.id, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    },
    additions: stats.additions,
    deletions: stats.deletions,
    changed_files: stats.changed,
    commits: countCommits(store, repo, pull),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${OWNER_URL(repo)}/pulls/${pull.number}`,
  };
}

/** Commits on the head that the base does not have. */
function countCommits(store: Store, repo: Repo, pull: PullRequest): number {
  const headTip = store.refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = store.refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (!headTip) return 0;
  let count = 0;
  const seen = new Set<string>();
  const queue: string[] = [headTip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (baseTip && store.isAncestor(repo, oid, baseTip)) continue;
    count += 1;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return count;
}

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice a list into a page and build GitHub's Link header (same origin as the request). */
function paginate<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: T[]): { page: T[]; link: string } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? 'entry';
  const base = `http://${host}${path}`;
  const linkFor = (p: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${base}?${q.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(totalPages, 'last'));
  return { page: slice, link: links.join(', ') };
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badJson(res: ServerResponse): void {
  sendJson(res, 400, { message: 'Malformed JSON body' });
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Route one /api/v3 request. Returns true when handled (including the JSON
 * 404 for unknown routes); the caller answers anything else.
 */
export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const seg = segments(path);

  // API root and meta need no token.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (!path.startsWith('/api/v3/')) return false;

  // Everything else under /api/v3 is authenticated by the caller (app.ts).
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: 'VXNlcjoxMDAw',
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
      html_url: `https://example.invalid/${VIEWER.login}`,
      url: '/api/v3/user',
    });
    return true;
  }

  if (seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const { page, link } = paginate(req, path, query, repos);
      sendJson(res, 200, page.map((r) => repoJson(r)), { link });
      return true;
    }
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined) {
        badJson(res);
        return true;
      }
      const input = isRecord(body) ? body : {};
      const name = typeof input.name === 'string' ? input.name : '';
      if (!REPO_NAME_RE.test(name) || name.endsWith('.git')) {
        sendJson(res, 422, { message: 'Invalid repository name' });
        return true;
      }
      if (store.getRepo(VIEWER.login, name)) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      const repo = store.createRepo(VIEWER.login, name, {
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
      })!;
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    notFound(res);
    return true;
  }

  if (seg[2] === 'repos' && seg.length >= 5) {
    const owner = seg[3]!;
    const repoName = seg[4]!;
    if (owner !== VIEWER.login) {
      notFound(res);
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      notFound(res);
      return true;
    }
    return handleRepoRoute(store, repo, req, res, seg.slice(5), query, path);
  }

  notFound(res);
  return true;
}

async function handleRepoRoute(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  query: URLSearchParams,
  path: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // GET /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined) {
        badJson(res);
        return true;
      }
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
      }
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204);
      res.end();
      return true;
    }
    notFound(res);
    return true;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      sendJson(res, 200, branches.map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`) },
        protected: false,
      })));
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!oid) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: oid }, protected: false });
      return true;
    }
    notFound(res);
    return true;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    let tip: string | null = null;
    if (shaParam) {
      tip = store.refCommit(repo, `refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null);
      if (!tip) {
        notFound(res);
        return true;
      }
    } else {
      tip = store.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
    }
    const commits = store.listCommits(repo, tip);
    const { page, link } = paginate(req, path, query, commits);
    sendJson(
      res,
      200,
      page.map((oid) => {
        const object = repo.objects.get(oid)!;
        const view = parseCommit(object.data);
        const message = view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message;
        return {
          sha: oid,
          node_id: `Q29tbWl0O${oid}`,
          commit: {
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
            committer: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
            tree: { sha: view.tree },
          },
          parents: view.parents.map((p) => ({ sha: p })),
          url: `${OWNER_URL(repo)}/commits/${oid}`,
        };
      }),
      { link },
    );
    return true;
  }

  // Git Data API.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || !isRecord(body)) {
        badJson(res);
        return true;
      }
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type }, url: `${OWNER_URL(repo)}/git/refs/${ref}` });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' }, url: `${OWNER_URL(repo)}/git/refs/${ref}` });
      return true;
    }
    notFound(res);
    return true;
  }

  // Contents.
  if (rest[0] === 'contents') {
    return handleContents(store, repo, req, res, rest.slice(1), query);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || !isRecord(body)) {
        badJson(res);
        return true;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Label already exists' });
        return true;
      }
      const label = {
        name,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(repo, label));
      return true;
    }
    notFound(res);
    return true;
  }

  // Issues.
  if (rest[0] === 'issues') {
    return handleIssues(store, repo, req, res, rest.slice(1), query, path);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(store, repo, req, res, rest.slice(1), query, path);
  }

  notFound(res);
  return true;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

async function handleContents(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const filePath = rest.join('/');
  const refParam = query.get('ref');
  const branch = refParam ?? repo.defaultBranch;
  const tip = store.refCommit(repo, `refs/heads/${branch}`);

  if (method === 'GET') {
    if (!tip) {
      notFound(res);
      return true;
    }
    const tree = store.commitTree(repo, tip)!;
    const flat = store.flattenTree(repo, tree);
    const entry = flat.get(filePath);
    if (entry) {
      const object = repo.objects.get(entry.oid)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: object.data.toString('base64'),
        sha: hashObject('blob', object.data),
        url: `${OWNER_URL(repo)}/contents/${filePath}`,
      });
      return true;
    }
    // A directory: entries directly under the path.
    const prefix = filePath === '' ? '' : `${filePath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [p, e] of flat) {
      if (!p.startsWith(prefix)) continue;
      const restPath = p.slice(prefix.length);
      const first = restPath.split('/')[0]!;
      if (restPath.includes('/')) {
        children.set(first, { type: 'dir', name: first, path: `${prefix}${first}`, sha: '' });
      } else {
        children.set(first, { type: 'file', name: first, path: p, sha: e.oid });
      }
    }
    if (children.size === 0) {
      notFound(res);
      return true;
    }
    // Directory shas come from the tree objects.
    const dirEntries: Array<Record<string, unknown>> = [];
    const walkTree = (treeOid: string, at: string): void => {
      const object = repo.objects.get(treeOid);
      if (!object) return;
      for (const e of parseTreeEntries(object.data)) {
        const p = at === '' ? e.name : `${at}/${e.name}`;
        if (p === filePath && e.mode === '40000') {
          for (const child of parseTreeEntries(repo.objects.get(e.oid)?.data ?? Buffer.alloc(0))) {
            const childPath = `${filePath}/${child.name}`;
            dirEntries.push({
              type: child.mode === '40000' ? 'dir' : 'file',
              name: child.name,
              path: childPath,
              sha: child.oid,
              size: child.mode === '40000' ? undefined : repo.objects.get(child.oid)?.data.length,
              url: `${OWNER_URL(repo)}/contents/${childPath}`,
            });
          }
          return;
        }
        if (e.mode === '40000' && filePath.startsWith(`${p}/`)) walkTree(e.oid, p);
      }
    };
    if (filePath === '') {
      for (const e of parseTreeEntries(repo.objects.get(tree)?.data ?? Buffer.alloc(0))) {
        dirEntries.push({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.name,
          sha: e.oid,
          size: e.mode === '40000' ? undefined : repo.objects.get(e.oid)?.data.length,
          url: `${OWNER_URL(repo)}/contents/${e.name}`,
        });
      }
    } else {
      walkTree(tree, '');
    }
    if (dirEntries.length === 0) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, dirEntries);
    return true;
  }

  if (method === 'PUT') {
    const body = parseJsonBody(await readBody(req));
    if (body === undefined || !isRecord(body)) {
      badJson(res);
      return true;
    }
    const message = typeof body.message === 'string' ? body.message : '';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const content = Buffer.from(contentB64, 'base64');
    const branchParam = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
    const targetTip = store.refCommit(repo, `refs/heads/${branchParam}`);
    let currentSha: string | undefined;
    if (targetTip) {
      const tree = store.commitTree(repo, targetTip)!;
      currentSha = store.flattenTree(repo, tree).get(filePath)?.oid;
    }
    if (currentSha) {
      if (shaParam === undefined) {
        sendJson(res, 409, { message: 'sha is required to update a file' });
        return true;
      }
      if (shaParam.toLowerCase() !== currentSha.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return true;
      }
    }
    const { commit } = store.commitFile(repo, branchParam, filePath, content, message);
    const blobSha = hashObject('blob', content);
    sendJson(res, currentSha ? 200 : 201, {
      content: {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobSha,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
        url: `${OWNER_URL(repo)}/contents/${filePath}`,
      },
      commit: { sha: commit, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(await readBody(req));
    if (body === undefined || !isRecord(body)) {
      badJson(res);
      return true;
    }
    if (!tip) {
      notFound(res);
      return true;
    }
    const tree = store.commitTree(repo, tip)!;
    const flat = store.flattenTree(repo, tree);
    const entry = flat.get(filePath);
    if (!entry) {
      notFound(res);
      return true;
    }
    const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
    if (shaParam && shaParam.toLowerCase() !== entry.oid.toLowerCase()) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return true;
    }
    const paths = new Map<string, string>();
    for (const [p, e] of flat) if (p !== filePath) paths.set(p, e.oid);
    const newTree = store.treeFromPaths(repo, paths);
    const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
    const commitOid = store.putObject(
      repo,
      'commit',
      buildCommit({
        tree: newTree,
        parents: [tip],
        message: message.endsWith('\n') ? message : `${message}\n`,
        author: `${VIEWER.name} <${VIEWER.email}>`,
        committer: `${VIEWER.name} <${VIEWER.email}>`,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    sendJson(res, 200, { commit: { sha: commitOid, message } });
    return true;
  }

  notFound(res);
  return true;
}

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const out: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    out.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

async function handleIssues(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  query: URLSearchParams,
  path: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || !isRecord(body)) {
        badJson(res);
        return true;
      }
      const created = store.createIssue(repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        labels: Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [],
      });
      if ('error' in created) {
        sendJson(res, created.status, { message: created.error });
        return true;
      }
      sendJson(res, 201, issueJson(repo, created.issue));
      return true;
    }
    if (method === 'GET') {
      let list = [...repo.issues.values()];
      const state = query.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, link } = paginate(req, path, query, list);
      sendJson(res, 200, page.map((i) => issueJson(repo, i)), { link });
      return true;
    }
    notFound(res);
    return true;
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) {
    notFound(res);
    return true;
  }
  const issue = repo.issues.get(number);
  if (!issue) {
    notFound(res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || !isRecord(body)) {
        badJson(res);
        return true;
      }
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? new Date().toISOString() : null;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = new Date().toISOString();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    notFound(res);
    return true;
  }

  if (rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, (repo.issueComments.get(number) ?? []).map((c) => commentJson(repo, number, c)));
      return true;
    }
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || !isRecord(body) || typeof body.body !== 'string' || body.body === '') {
        sendJson(res, 422, { message: 'body is required' });
        return true;
      }
      const created = store.addComment(repo, number, body.body);
      sendJson(res, 201, commentJson(repo, number, created));
      return true;
    }
    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

async function handlePulls(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  query: URLSearchParams,
  path: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || !isRecord(body)) {
        badJson(res);
        return true;
      }
      const created = store.createPull(repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        head: typeof body.head === 'string' ? body.head : '',
        base: typeof body.base === 'string' ? body.base : repo.defaultBranch,
      });
      if ('error' in created) {
        sendJson(res, created.status, { message: created.error });
        return true;
      }
      sendJson(res, 201, pullJson(store, repo, created.pull));
      return true;
    }
    if (method === 'GET') {
      let list = [...repo.pulls.values()];
      const state = query.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(req, path, query, list);
      sendJson(res, 200, page.map((p) => pullJson(store, repo, p)), { link });
      return true;
    }
    notFound(res);
    return true;
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) {
    notFound(res);
    return true;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    notFound(res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(store, repo, pull));
      return true;
    }
    notFound(res);
    return true;
  }

  if (rest[1] === 'files' && method === 'GET') {
    const mb = store.mergeBase(repo, pull.baseSha, pull.headSha);
    const baseTree = mb ? store.commitTree(repo, mb) : null;
    const headTree = store.commitTree(repo, pull.headSha);
    const diff = store.diffTrees(repo, baseTree, headTree);
    sendJson(
      res,
      200,
      diff.map((file) => {
        const counts = store.lineCounts(repo, file.oldOid, file.newOid);
        return {
          sha: file.newOid ?? file.oldOid ?? '',
          filename: file.path,
          status: file.status,
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        };
      }),
    );
    return true;
  }

  if (rest[1] === 'merge' && method === 'PUT') {
    // The body is optional; read and ignore it.
    await readBody(req).catch(() => Buffer.alloc(0));
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) {
      sendJson(res, merged.status, { message: merged.error });
      return true;
    }
    sendJson(res, 200, {
      sha: merged.sha,
      merged: true,
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
    });
    return true;
  }

  notFound(res);
  return true;
}
