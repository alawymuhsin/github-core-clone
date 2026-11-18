// GraphQL at /api/graphql: a hand-rolled parser and executor for exactly the
// documents the kit's checks send (gh and github-mcp-server shapes), plus
// __type introspection for Issue, PullRequest, Repository and SearchType.
// No dependency, no network.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, readBody, sendJson } from './http-util.ts';
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

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}', '.']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (t: Token): void => {
    tokens.push(t);
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          value += map[esc ?? ''] ?? esc ?? '';
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      if (i >= source.length) throw new Error('unterminated string');
      i += 1;
      push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.kind} ${'value' in t ? t.value : ''}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.kind}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    const t = this.peek();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value;
      this.next();
      if (this.peek().kind === 'name') name = this.next().value as string;
    } else {
      throw new Error('expected an operation');
    }
    const variables = this.parseVariableDefinitions();
    this.skipDirectives();
    return { kind, name, variables, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const out: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        out.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return out;
  }

  private parseType(): void {
    // [Type!]! etc. — the concrete type string is irrelevant to execution.
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      throw new Error('named fragment spreads are not supported');
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        out.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected token ${t.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function resolveValue(node: ValueNode, variables: Record<string, JsonValue>): JsonValue {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: { [key: string]: JsonValue } = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Object model
// ---------------------------------------------------------------------------------------------

interface Obj {
  __typename: string;
  value: unknown;
}

const obj = (typename: string, value: unknown): Obj => ({ __typename: typename, value });

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function sortIssues(issues: Issue[], orderBy: JsonValue): Issue[] {
  const order = isRecord(orderBy) ? orderBy : {};
  const field = typeof order.field === 'string' ? order.field : 'CREATED_AT';
  const direction = order.direction === 'ASC' ? 1 : -1;
  const sorted = [...issues];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else cmp = a.createdSeq - b.createdSeq;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * direction;
  });
  return sorted;
}

// ---------------------------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  SearchType: 'ENUM',
};

function typeObject(name: string): Obj | null {
  if (!(name in TYPE_KIND) && name !== 'User' && name !== 'BranchRef') return null;
  if (name === 'User') return obj('__Type', { name, kind: 'OBJECT', fields: ['login'] });
  if (name === 'BranchRef') return obj('__Type', { name, kind: 'OBJECT', fields: ['name'] });
  const fields = TYPE_FIELDS[name] ?? [];
  return obj('__Type', { name, kind: TYPE_KIND[name]!, fields, enumValues: name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER'] : null });
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  errors: Array<{ message: string }>;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, JsonValue>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { store, errors: [] };
  const mergedVars: Record<string, JsonValue> = { ...variables };
  for (const def of operation.variables) {
    if (mergedVars[def.name] === undefined && def.defaultValue) mergedVars[def.name] = resolveValue(def.defaultValue, variables);
  }
  const data = executeSelections(operation.kind === 'mutation' ? 'Mutation' : 'Query', null, operation.selections, mergedVars, ctx);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

function executeSelections(
  typename: string,
  source: unknown,
  selections: SelectionNode[],
  variables: Record<string, JsonValue>,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== typename) continue;
      Object.assign(out, executeSelections(typename, source, selection.selections, variables, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(typename, source, selection, variables, ctx);
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[key] = value instanceof Object && '__typename' in (value as object) ? null : (value as JsonValue);
    } else if (value instanceof Array) {
      out[key] = value.map((item) =>
        item && typeof item === 'object' && '__typename' in (item as object)
          ? executeSelections((item as Obj).__typename, (item as Obj).value, selection.selections, variables, ctx)
          : null,
      );
    } else if (value && typeof value === 'object' && '__typename' in (value as object)) {
      out[key] = executeSelections((value as Obj).__typename, (value as Obj).value, selection.selections, variables, ctx);
    } else {
      out[key] = value as JsonValue;
    }
  }
  return out;
}

function fieldError(ctx: ExecContext, typename: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typename}".` });
}

function resolveField(
  typename: string,
  source: unknown,
  field: FieldNode,
  variables: Record<string, JsonValue>,
  ctx: ExecContext,
): unknown {
  const args = argsOf(field, variables);
  const store = ctx.store;

  if (field.name === '__typename') return typename;

  if (typename === 'Query') {
    if (field.name === 'viewer') return obj('User', { login: VIEWER.login });
    if (field.name === 'repository') {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (owner !== VIEWER.login || !name) return null;
      const repo = store.getRepo(owner, name);
      return repo ? obj('Repository', repo) : null;
    }
    if (field.name === 'node') {
      const resolved = store.resolveGlobalId(typeof args.id === 'string' ? args.id : '');
      if (!resolved) return null;
      if (resolved.kind === 'R') return obj('Repository', resolved.repo);
      if (resolved.kind === 'I') return obj('Issue', { repo: resolved.repo, issue: resolved.issue });
      if (resolved.kind === 'P') return obj('PullRequest', { repo: resolved.repo, pull: resolved.pull });
      return null;
    }
    if (field.name === '__type') {
      return typeof args.name === 'string' ? typeObject(args.name) : null;
    }
    if (field.name === '__schema') {
      return obj('__Schema', {});
    }
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'Mutation') {
    const input = isRecord(args.input) ? args.input : {};
    if (field.name === 'createIssue') {
      const resolved = store.resolveGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (!resolved || resolved.kind !== 'R') {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const repo = resolved.repo;
      const created = store.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return obj('CreateIssuePayload', { issue: { repo, issue: created.issue } });
    }
    if (field.name === 'closeIssue') {
      const resolved = store.resolveGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      if (!resolved || resolved.kind !== 'I') {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      const repo = resolved.repo;
      const issue = resolved.issue;
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.updatedAt = new Date().toISOString();
      return obj('CloseIssuePayload', { issue: { repo, issue } });
    }
    if (field.name === 'createPullRequest') {
      const resolved = store.resolveGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (!resolved || resolved.kind !== 'R') {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const repo = resolved.repo;
      const created = store.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return obj('CreatePullRequestPayload', { pullRequest: { repo, pull: created.pull } });
    }
    if (field.name === 'mergePullRequest') {
      const resolved = store.resolveGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (!resolved || resolved.kind !== 'P') {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      const repo = resolved.repo;
      const pull = resolved.pull;
      const merged = store.mergePull(repo!, pull);
      if ('error' in merged) {
        ctx.errors.push({ message: merged.error });
        return null;
      }
      return obj('MergePullRequestPayload', { pullRequest: { repo, pull } });
    }
    if (field.name === 'addComment') {
      const resolved = store.resolveGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      if (!resolved || resolved.kind !== 'I') {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      const repo = resolved.repo;
      const issue = resolved.issue;
      const comment = store.addComment(repo!, issue.number, typeof input.body === 'string' ? input.body : '');
      return obj('AddCommentPayload', { commentEdge: { node: { id: commentGlobalId(repo!.owner, repo!.name, issue.number, comment.id), body: comment.body } } });
    }
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'User') {
    const user = source as { login: string };
    if (field.name === 'login') return user.login;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'Repository') {
    const repo = source as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo.owner, repo.name);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return obj('User', { login: repo.owner });
      case 'defaultBranchRef': {
        const tip = store.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
        return tip ? obj('BranchRef', { name: repo.defaultBranch }) : null;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'issue': {
        const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
        return issue ? obj('Issue', { repo, issue }) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states && !states.includes('ALL')) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        list = sortIssues(list, args.orderBy);
        const after = cursorNumber(args.after);
        if (after !== null) {
          const direction = isRecord(args.orderBy) && args.orderBy.direction === 'ASC' ? 1 : -1;
          list = direction === 1 ? list.filter((i) => i.number > after) : list.filter((i) => i.number < after);
        }
        const first = typeof args.first === 'number' ? args.first : 10;
        const page = list.slice(0, first);
        const hasNext = list.length > first;
        return obj('IssueConnection', {
          nodes: page.map((issue) => obj('Issue', { repo, issue })),
          pageInfo: { hasNextPage: hasNext, endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null },
          totalCount: list.length,
        });
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : -1);
        return pull ? obj('PullRequest', { repo, pull }) : null;
      }
      case 'pullRequests': {
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const first = typeof args.first === 'number' ? args.first : 10;
        const after = cursorNumber(args.after);
        const filtered = after !== null ? list.filter((p) => p.number < after) : list;
        const page = filtered.slice(0, first);
        return obj('PullRequestConnection', {
          nodes: page.map((pull) => obj('PullRequest', { repo, pull })),
          pageInfo: { hasNextPage: filtered.length > first, endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null },
          totalCount: filtered.length,
        });
      }
      default:
        fieldError(ctx, typename, field.name);
        return undefined;
    }
  }

  if (typename === 'Issue') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo.owner, repo.name, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      default:
        fieldError(ctx, typename, field.name);
        return undefined;
    }
  }

  if (typename === 'PullRequest') {
    const { repo, pull } = source as { repo: Repo; pull: PullRequest };
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo.owner, repo.name, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.state.toUpperCase();
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable': {
        const baseTip = store.refCommit(repo, `refs/heads/${pull.baseRef}`);
        const headTip = store.refCommit(repo, `refs/heads/${pull.headRef}`);
        if (pull.state !== 'open' || !baseTip || !headTip) return 'UNKNOWN';
        return store.mergeable(repo, baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'files': {
        const mb = store.mergeBase(repo, pull.baseSha, pull.headSha);
        const baseTree = mb ? store.commitTree(repo, mb) : null;
        const headTree = store.commitTree(repo, pull.headSha);
        const diff = store.diffTrees(repo, baseTree, headTree);
        const first = typeof args.first === 'number' ? args.first : 10;
        return obj('FileConnection', {
          nodes: diff.slice(0, first).map((file) => obj('File', { path: file.path })),
          pageInfo: { hasNextPage: diff.length > first, endCursor: null },
        });
      }
      default:
        fieldError(ctx, typename, field.name);
        return undefined;
    }
  }

  if (typename === 'BranchRef') {
    if (field.name === 'name') return (source as { name: string }).name;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'IssueConnection' || typename === 'PullRequestConnection' || typename === 'FileConnection') {
    const conn = source as { nodes: Obj[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount?: number };
    if (field.name === 'nodes') return conn.nodes;
    if (field.name === 'edges') {
      return conn.nodes.map((node) => obj('Edge', { node, cursor: null }));
    }
    if (field.name === 'pageInfo') return obj('PageInfo', conn.pageInfo);
    if (field.name === 'totalCount') return conn.totalCount ?? conn.nodes.length;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'File') {
    if (field.name === 'path') return (source as { path: string }).path;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'PageInfo') {
    const info = source as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return info.hasNextPage;
    if (field.name === 'endCursor') return info.endCursor;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'Edge') {
    const edge = source as { node: Obj; cursor: string | null };
    if (field.name === 'node') return edge.node;
    if (field.name === 'cursor') return edge.cursor;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === '__Type') {
    const t = source as { name: string; kind: string; fields: string[]; enumValues: string[] | null };
    switch (field.name) {
      case 'name':
        return t.name;
      case 'kind':
        return t.kind;
      case 'fields': {
        if (!t.fields) return null;
        return t.fields.map((name) => obj('__Field', { name }));
      }
      case 'enumValues': {
        if (!t.enumValues) return null;
        return t.enumValues.map((name) => obj('__EnumValue', { name }));
      }
      case 'description':
        return null;
      default:
        fieldError(ctx, typename, field.name);
        return undefined;
    }
  }

  if (typename === '__Field' || typename === '__EnumValue') {
    if (field.name === 'name') return (source as { name: string }).name;
    if (field.name === 'description') return null;
    if (field.name === 'args') return [];
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === '__Schema') {
    if (field.name === 'queryType') return obj('__Type', { name: 'Query', kind: 'OBJECT', fields: [] });
    if (field.name === 'mutationType') return obj('__Type', { name: 'Mutation', kind: 'OBJECT', fields: [] });
    if (field.name === 'types') return [];
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload') {
    const payload = source as { issue: { repo: Repo; issue: Issue } };
    if (field.name === 'issue') return obj('Issue', payload.issue);
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') {
    const payload = source as { pullRequest: { repo: Repo; pull: PullRequest } };
    if (field.name === 'pullRequest') return obj('PullRequest', payload.pullRequest);
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'AddCommentPayload') {
    const payload = source as { commentEdge: { node: { id: string; body: string } } };
    if (field.name === 'commentEdge') return obj('CommentEdge', payload.commentEdge);
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'CommentEdge') {
    const edge = source as { node: { id: string; body: string } };
    if (field.name === 'node') return obj('IssueComment', edge.node);
    if (field.name === 'cursor') return null;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  if (typename === 'IssueComment') {
    const comment = source as { id: string; body: string };
    if (field.name === 'id') return comment.id;
    if (field.name === 'body') return comment.body;
    fieldError(ctx, typename, field.name);
    return undefined;
  }

  fieldError(ctx, typename, field.name);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

/** POST /api/graphql. Returns true when handled. */
export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const body = parseJsonBody(await readBody(req));
  if (body === undefined) {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
    return true;
  }
  const docs = Array.isArray(body) ? body : [body];
  const results: Array<Record<string, unknown>> = [];
  for (const doc of docs) {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      results.push({ errors: [{ message: 'query is required' }] });
      continue;
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, JsonValue>) : {};
    let operations: Operation[];
    try {
      operations = new Parser(lex(doc.query)).parseDocument();
    } catch (error) {
      results.push({ errors: [{ message: error instanceof Error ? error.message : 'parse error' }] });
      continue;
    }
    if (operations.length === 0) {
      results.push({ errors: [{ message: 'no operation' }] });
      continue;
    }
    const operation = operations[0]!;
    if (doc.operationName && operation.name && doc.operationName !== operation.name) {
      // The named operation is not the first one; find it.
      const named = operations.find((op) => op.name === doc.operationName);
      results.push(named ? executeOperation(store, named, variables) : { errors: [{ message: `unknown operation ${String(doc.operationName)}` }] });
      continue;
    }
    results.push(executeOperation(store, operation, variables));
  }
  sendJson(res, 200, Array.isArray(body) ? results : results[0]!);
  return true;
}
