// The forge's in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments. One Store per server process; the trial runs
// a fresh pod per trial, so in-memory state is the whole database.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelDef[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  user: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface Repo {
  owner: string;
  name: string;
  id: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  objectSeq: Map<string, number>;
  refs: Map<string, string>;
  labels: Map<string, LabelDef>;
  issues: Map<number, Issue>;
  issueComments: Map<number, IssueComment[]>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  /**
   * Monotonic revision of the repo's git state (objects + refs). Every
   * mutation bumps it; the pack and ls-refs caches key their entries on it,
   * so a cached response is only ever served for the exact state it was
   * built from.
   */
  rev: number;
  /** Cached fetch responses: key → {rev, full response Buffer}. Bounded (8). */
  packCache: Map<string, { rev: number; buf: Buffer }>;
  /** Cached ls-refs responses: key → {rev, full response Buffer}. Bounded (8). */
  lsRefsCache: Map<string, { rev: number; buf: Buffer }>;
  /** Cached v0 info/refs advertisements, keyed by service. Bounded (2). */
  adCache: Map<string, { rev: number; buf: Buffer }>;
  /** Cached single-issue JSON bodies: number → {fingerprint, body Buffer}. */
  issueCache: Map<number, { fp: string; buf: Buffer }>;
}

/** Bump a repo's git revision after any objects/refs mutation. */
export function bumpRev(repo: Repo): void {
  repo.rev += 1;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Opaque, stable Relay-style global ids. `kind:R|I|P|C`, key e.g. `owner/name#3`. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(owner: string, name: string): string {
  return globalId('R', `${owner}/${name}`);
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return globalId('I', `${owner}/${name}#${number}`);
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return globalId('P', `${owner}/${name}#${number}`);
}

export function commentGlobalId(owner: string, name: string, number: number, commentId: number): string {
  return globalId('C', `${owner}/${name}#${number}:${commentId}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      owner,
      name,
      id: this.nextRepoId++,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      objects: new Map(),
      objectSeq: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueComments: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      rev: 0,
      packCache: new Map(),
      lsRefsCache: new Map(),
      adCache: new Map(),
      issueCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.objectSeq.set(oid, this.nextSeq());
      bumpRev(repo);
    }
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The commit a ref names, peeling tags; null when the ref is missing or not a commit. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return peelToCommit(oid, this.lookup(repo));
  }

  /** Build a tree object from a flat path → blob-oid map; returns the root tree oid. */
  treeFromPaths(repo: Repo, paths: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of [...paths].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const segments = path.split('/').filter((s) => s !== '');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Flatten a tree into path → {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The tree of a commit (peeling tags), or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const peeled = peelToCommit(commitOid, this.lookup(repo));
    if (!peeled) return null;
    const object = repo.objects.get(peeled);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /**
   * Commit one file change on a branch (creating the branch from the default
   * tip when it does not exist yet, and the first commit when the repo is
   * unborn). Returns the new commit oid.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commit: string; created: boolean } {
    const ref = `refs/heads/${branch}`;
    const tip = this.refCommit(repo, ref);
    let baseTree: string | null = null;
    let parentTip: string | null = tip;
    if (tip) baseTree = this.commitTree(repo, tip);
    else if (branch !== repo.defaultBranch) {
      // A new branch starts from the default branch tip.
      const defaultTip = this.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
      if (defaultTip) {
        baseTree = this.commitTree(repo, defaultTip);
        parentTip = defaultTip;
      }
    }
    const paths = new Map<string, string>();
    if (baseTree) {
      for (const [p, entry] of this.flattenTree(repo, baseTree)) paths.set(p, entry.oid);
    }
    const blob = this.putObject(repo, 'blob', content);
    paths.set(path, blob);
    const tree = this.treeFromPaths(repo, paths);
    const commit = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree,
        parents: parentTip ? [parentTip] : [],
        message: message.endsWith('\n') ? message : `${message}\n`,
        author: VIEWER_IDENTITY,
        committer: VIEWER_IDENTITY,
      }),
    );
    repo.refs.set(ref, commit);
    repo.updatedAt = nowIso();
    bumpRev(repo);
    return { commit, created: true };
  }

  /** All commits reachable from `tip`, newest first (timestamp, then insertion order). */
  listCommits(repo: Repo, tip: string): string[] {
    const reachable = collectReachable([tip], this.lookup(repo), { allowMissing: true });
    const commits: Array<{ oid: string; ts: number; seq: number }> = [];
    for (const oid of reachable) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      const stamp = Number.parseInt(view.author.split(' ').slice(-2, -1)[0] ?? '0', 10) || 0;
      commits.push({ oid, ts: stamp, seq: repo.objectSeq.get(oid) ?? 0 });
    }
    commits.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
    return commits.map((c) => c.oid);
  }

  /** True when `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    const lookup = this.lookup(repo);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge-base of two commits: the nearest common ancestor of `b` from `a`'s side. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    const lookup = this.lookup(repo);
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queueA.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const seen = new Set<string>();
    const queueB: string[] = [b];
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) {
        const peeled = peelToCommit(oid, lookup);
        if (peeled) return peeled;
      }
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queueB.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /**
   * Three-way merge of `headTip` into `baseTip`. Returns the merged path map
   * (blob oid, or null for deleted) or a conflict.
   */
  threeWayMerge(
    repo: Repo,
    baseTip: string,
    headTip: string,
  ): { ok: true; paths: Map<string, string | null> } | { ok: false; path: string } {
    const mb = this.mergeBase(repo, baseTip, headTip);
    const baseTree = mb ? this.commitTree(repo, mb) : null;
    const headTree = this.commitTree(repo, headTip);
    const tipTree = this.commitTree(repo, baseTip);
    const basePaths = baseTree ? this.flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
    const headPaths = headTree ? this.flattenTree(repo, headTree) : new Map<string, { oid: string; mode: string }>();
    const tipPaths = tipTree ? this.flattenTree(repo, tipTree) : new Map<string, { oid: string; mode: string }>();
    const all = new Set<string>([...basePaths.keys(), ...headPaths.keys(), ...tipPaths.keys()]);
    const merged = new Map<string, string | null>();
    for (const path of all) {
      const b = basePaths.get(path)?.oid;
      const h = headPaths.get(path)?.oid;
      const t = tipPaths.get(path)?.oid;
      if (h === b) {
        if (t !== undefined) merged.set(path, t);
      } else if (t === b) {
        if (h !== undefined) merged.set(path, h);
      } else if (h === t) {
        if (h !== undefined) merged.set(path, h);
      } else {
        return { ok: false, path };
      }
    }
    return { ok: true, paths: merged };
  }

  /** Whether `headTip` merges cleanly into `baseTip`. */
  mergeable(repo: Repo, baseTip: string, headTip: string): boolean {
    return this.threeWayMerge(repo, baseTip, headTip).ok;
  }

  /** The file-level diff between two trees (merge-base → head), for PR files. */
  diffTrees(
    repo: Repo,
    fromTree: string | null,
    toTree: string | null,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }> {
    const from = fromTree ? this.flattenTree(repo, fromTree) : new Map<string, { oid: string; mode: string }>();
    const to = toTree ? this.flattenTree(repo, toTree) : new Map<string, { oid: string; mode: string }>();
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }> = [];
    const all = new Set<string>([...from.keys(), ...to.keys()]);
    for (const path of [...all].sort()) {
      const f = from.get(path);
      const t = to.get(path);
      if (f && !t) out.push({ path, status: 'removed', oldOid: f.oid });
      else if (!f && t) out.push({ path, status: 'added', newOid: t.oid });
      else if (f && t && f.oid !== t.oid) out.push({ path, status: 'modified', oldOid: f.oid, newOid: t.oid });
    }
    return out;
  }

  /** Line counts for a changed file (simple multiset line diff). */
  lineCounts(repo: Repo, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
    const oldLines = oldOid ? this.blobLines(repo, oldOid) : [];
    const newLines = newOid ? this.blobLines(repo, newOid) : [];
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCount.get(line) ?? 0;
      if (left > 0) oldCount.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCount.values()) deletions += left;
    return { additions, deletions };
  }

  blobLines(repo: Repo, oid: string): string[] {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): { issue: Issue } | { error: string; status: number } {
    const labels: LabelDef[] = [];
    for (const name of input.labels ?? []) {
      const def = repo.labels.get(name);
      if (!def) return { error: `Label '${name}' does not exist`, status: 422 };
      labels.push(def);
    }
    if (!input.title || input.title.trim() === '') return { error: 'title is required', status: 422 };
    const number = repo.nextNumber++;
    // One timestamp per creation — the three fields always agree anyway.
    const now = nowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      user: VIEWER.login,
    };
    repo.issues.set(number, issue);
    repo.issueComments.set(number, []);
    repo.updatedAt = now;
    return { issue };
  }

  addComment(repo: Repo, issueNumber: number, body: string): { id: number; body: string; createdAt: string; user: string } {
    const comment = { id: this.nextCommentId++, body, createdAt: nowIso(), user: VIEWER.login };
    const list = repo.issueComments.get(issueNumber) ?? [];
    list.push(comment);
    repo.issueComments.set(issueNumber, list);
    return comment;
  }

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): { pull: PullRequest } | { error: string; status: number } {
    const headTip = this.refCommit(repo, `refs/heads/${input.head}`);
    const baseTip = this.refCommit(repo, `refs/heads/${input.base}`);
    if (!headTip) return { error: `head branch '${input.head}' does not exist`, status: 422 };
    if (!baseTip) return { error: `base branch '${input.base}' does not exist`, status: 422 };
    if (!input.title || input.title.trim() === '') return { error: 'title is required', status: 422 };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        return { error: `A pull request already exists for ${input.head}`, status: 422 };
      }
    }
    const number = repo.nextNumber++;
    const now = nowIso();
    const pull: PullRequest = {
      id: this.nextPullId++,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha: headTip,
      baseSha: baseTip,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      user: VIEWER.login,
    };
    repo.pulls.set(number, pull);
    repo.updatedAt = now;
    return { pull };
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * sha, or an error with the HTTP status the REST surface answers.
   */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const baseTip = this.refCommit(repo, `refs/heads/${pull.baseRef}`);
    const headTip = this.refCommit(repo, `refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return { error: 'head or base branch is missing', status: 422 };
    const merged = this.threeWayMerge(repo, baseTip, headTip);
    if (!merged.ok) return { error: `Merge conflict in ${merged.path}`, status: 405 };
    const paths = new Map<string, string>();
    for (const [path, oid] of merged.paths) if (oid !== null) paths.set(path, oid);
    const tree = this.treeFromPaths(repo, paths);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const commit = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree,
        parents: [baseTip],
        message: `${message}\n`,
        author: VIEWER_IDENTITY,
        committer: VIEWER_IDENTITY,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = commit;
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = nowIso();
    bumpRev(repo);
    return { sha: commit };
  }

  /** Resolve a Relay global id to its object, for GraphQL node() and mutations. */
  resolveGlobalId(
    id: string,
  ): { kind: 'R'; repo: Repo } | { kind: 'I'; repo: Repo; issue: Issue } | { kind: 'P'; repo: Repo; pull: PullRequest } | null {
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    if (parsed.kind === 'R') {
      const slash = parsed.key.indexOf('/');
      if (slash < 1) return null;
      const repo = this.getRepo(parsed.key.slice(0, slash), parsed.key.slice(slash + 1));
      return repo ? { kind: 'R', repo } : null;
    }
    const hash = parsed.key.indexOf('#');
    if (hash < 1) return null;
    const ownerName = parsed.key.slice(0, hash);
    const slash = ownerName.indexOf('/');
    if (slash < 1) return null;
    const repo = this.getRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
    if (!repo) return null;
    const rest = parsed.key.slice(hash + 1);
    if (parsed.kind === 'I' || parsed.kind === 'P') {
      const number = Number.parseInt(rest, 10);
      if (!Number.isInteger(number)) return null;
      if (parsed.kind === 'I') {
        const issue = repo.issues.get(number);
        return issue ? { kind: 'I', repo, issue } : null;
      }
      const pull = repo.pulls.get(number);
      return pull ? { kind: 'P', repo, pull } : null;
    }
    return null;
  }

  isObjectId(value: string): boolean {
    return isObjectId(value);
  }
}
