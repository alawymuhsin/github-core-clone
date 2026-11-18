// git smart HTTP: info/refs advertisements (v0 and v2), upload-pack (v2 fetch
// and the v0 fallback) and receive-pack (v0, report-status + side-band-64k).
// Every byte shape follows what the kit's git-client.ts parses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { readBody, sendBuffer, sendJson } from './http-util.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0';

const UPLOAD_V2_CAPS = ['agent=github-core-clone/1.0', 'ls-refs', 'fetch=shallow filter', 'object-format=sha1'];
const UPLOAD_V0_CAPS =
  'side-band-64k multi_ack_detailed thin-pack no-progress ofs-delta shallow symref=HEAD:refs/heads/main agent=github-core-clone/1.0';
const RECEIVE_V0_CAPS =
  'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0 symref=HEAD:refs/heads/main';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Sorted ref names, byte order, HEAD first when it exists. */
function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function defaultBranchTip(repo: Repo): string | null {
  const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return oid ?? null;
}

/**
 * The v0 ref advertisement lines (without the service preamble): HEAD first
 * carrying the capabilities, then every ref, peeled tag lines after their tag.
 */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    return lines;
  }
  const tip = defaultBranchTip(repo);
  let first = true;
  const emit = (text: string): void => {
    if (first) {
      lines.push(encodePktLine(`${text}\u0000${caps}\n`));
      first = false;
    } else {
      lines.push(encodePktLine(`${text}\n`));
    }
  };
  if (tip) emit(`${tip} HEAD`);
  else emit(`${ZERO_OID} HEAD`);
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    emit(`${oid} ${name}`);
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(oid, (id) => repo.objects.get(id));
      if (peeled) lines.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const gitProtocol = req.headers['git-protocol'];
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const parts: Buffer[] = [encodePktLine('version 2\n')];
    for (const cap of UPLOAD_V2_CAPS) parts.push(encodePktLine(`${cap}\n`));
    parts.push(pktLineFlush());
    sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_AD);
    return;
  }
  if (service === 'git-upload-pack') {
    const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush(), ...v0RefLines(repo, UPLOAD_V0_CAPS), pktLineFlush()];
    sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_AD);
    return;
  }
  if (service === 'git-receive-pack') {
    const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush(), ...v0RefLines(repo, RECEIVE_V0_CAPS), pktLineFlush()];
    sendBuffer(res, 200, Buffer.concat(parts), RECEIVE_AD);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in pack order (sorted by oid for determinism). */
  objects: GitObject[];
  /** New shallow boundary commits (depth cut). */
  shallow: string[];
  /** Previous boundary commits that are complete now. */
  unshallow: string[];
  /** wants that name a current ref, for the wanted-refs section. */
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/**
 * The objects a fetch sends, with shallow/deepen handling.
 *
 * - generations are counted from the wanted commits (wants are depth 1);
 * - with a depth limit only commits at depth <= N are included, and only their
 *   trees/blobs travel;
 * - a have the client already holds contributes its full closure, except a
 *   shallow have, which contributes only itself and its tree (its history is
 *   exactly what the client does not have yet).
 */
function planFetch(repo: Repo, wants: string[], haves: string[], prevShallow: string[], depth: number | null): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const prevShallowSet = new Set(prevShallow);

  // Generation numbers from the wanted commits.
  const generations = new Map<string, number>();
  const tagObjects: GitObject[] = [];
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  const refByOid = new Map<string, string>();
  for (const [name, oid] of repo.refs) if (!refByOid.has(oid)) refByOid.set(oid, name);
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const ref = refByOid.get(want);
    if (ref) wantedRefs.push({ oid: want, ref });
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      const target = parseTag(object.data).object;
      const peeled = peelToCommit(target, lookup);
      if (peeled) queue.push({ oid: peeled, depth: 1 });
      else queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else {
      // A want naming a tree or blob directly: send the object itself.
      tagObjects.push(object);
    }
  }
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    if (generations.has(oid)) continue;
    generations.set(oid, d);
    if (depth !== null && d >= depth) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generations.has(parent)) queue.push({ oid: parent, depth: d + 1 });
    }
  }

  const included = new Set<string>();
  for (const [oid, d] of generations) if (depth === null || d <= depth) included.add(oid);

  // What the client already holds.
  const haveClosure = new Set<string>();
  for (const have of haves) {
    if (prevShallowSet.has(have)) {
      // A shallow have: the commit itself plus its tree, not its history.
      haveClosure.add(have);
      const haveObject = lookup(have);
      const tree = haveObject && haveObject.type === 'commit' ? parseCommit(haveObject.data).tree : null;
      if (tree) {
        const closure = collectReachable([tree], lookup, { allowMissing: true });
        for (const oid of closure) haveClosure.add(oid);
      }
    } else {
      for (const oid of collectReachable([have], lookup, { allowMissing: true })) haveClosure.add(oid);
    }
  }

  const send = new Map<string, GitObject>();
  for (const oid of included) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    // The commit itself, plus its tree closure only — never its parents, or a
    // shallow fetch would leak history past the depth cut.
    if (!haveClosure.has(oid)) send.set(oid, object);
    const tree = parseCommit(object.data).tree;
    for (const reached of collectReachable([tree], lookup, { allowMissing: true })) {
      if (haveClosure.has(reached)) continue;
      const found = lookup(reached);
      if (found) send.set(reached, found);
    }
  }
  for (const tag of tagObjects) {
    if (!haveClosure.has(hashOf(tag))) send.set(hashOf(tag), tag);
  }
  // Tag objects reached through commits are already in `send`; a wanted tag whose
  // target commit is included travels with it.

  const objects = [...send.values()].sort((a, b) => {
    const ao = hashOf(a);
    const bo = hashOf(b);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });

  // Shallow boundary: included commits at the depth cut whose history is not
  // fully present afterwards. A parent is present when it is included, or it is
  // a have that is not itself a shallow boundary.
  const shallow: string[] = [];
  if (depth !== null) {
    const present = (oid: string): boolean => {
      if (included.has(oid)) return true;
      if (haves.includes(oid) && !prevShallowSet.has(oid)) return true;
      return false;
    };
    for (const [oid, d] of generations) {
      if (d !== depth || !included.has(oid)) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      if (parents.some((p) => !present(p))) shallow.push(oid);
    }
  }

  // Unshallow: a previous boundary commit whose parents are all present now.
  const unshallow: string[] = [];
  if (prevShallow.length > 0) {
    const presentNow = (oid: string): boolean => {
      if (included.has(oid)) return true;
      if (haves.includes(oid) && !prevShallowSet.has(oid)) return true;
      return false;
    };
    let changed = true;
    const done = new Set<string>();
    while (changed) {
      changed = false;
      for (const boundary of prevShallow) {
        if (done.has(boundary)) continue;
        const object = lookup(boundary);
        if (!object || object.type !== 'commit') {
          done.add(boundary);
          unshallow.push(boundary);
          changed = true;
          continue;
        }
        const parents = parseCommit(object.data).parents;
        const complete =
          (included.has(boundary) || haves.includes(boundary)) && parents.every((p) => presentNow(p) || done.has(p));
        if (complete) {
          done.add(boundary);
          unshallow.push(boundary);
          changed = true;
        }
      }
    }
  }

  return { objects, shallow, unshallow, wantedRefs };
}

function hashOf(object: GitObject): string {
  return hashObject(object.type, object.data);
}

/** One sideband band-1 packet stream carrying `data`, chunked under the pkt-line cap. */
function sidebandPackets(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  if (data.length === 0) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1])])));
    return parts;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

export async function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const gitProtocol = req.headers['git-protocol'];
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const dataLines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') dataLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const isV2 = gitProtocol === 'version=2' || dataLines[0] === 'command=fetch' || dataLines[0] === 'command=ls-refs';

  if (isV2 && dataLines[0] === 'command=ls-refs') {
    handleLsRefs(repo, dataLines, res);
    return;
  }
  if (isV2 && dataLines[0] !== 'command=fetch') {
    sendJson(res, 400, { message: 'unsupported v2 command' });
    return;
  }

  // Parse the fetch request (v2 and v0 share the want/have/deepen vocabulary).
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of dataLines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const unknownWant = wants.find((w) => !lookup(w));
  if (unknownWant) {
    const error = `want ${unknownWant} not found`;
    if (isV2) {
      const parts: Buffer[] = [
        encodePktLine('acknowledgments\n'),
        encodePktLine('NAK\n'),
        pktLineDelim(),
        encodePktLine('packfile\n'),
        encodePktLine(Buffer.concat([Buffer.from([3]), Buffer.from(error, 'utf8')])),
        pktLineFlush(),
      ];
      sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
    } else {
      const parts: Buffer[] = [encodePktLine(Buffer.concat([Buffer.from([3]), Buffer.from(error, 'utf8')])), pktLineFlush()];
      sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
    }
    return;
  }

  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);

  if (isV2) {
    const parts: Buffer[] = [encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktLineDelim()];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(pktLineDelim());
    }
    if (plan.wantedRefs.length > 0) {
      parts.push(encodePktLine('wanted-refs\n'));
      for (const ref of plan.wantedRefs) parts.push(encodePktLine(`${ref.oid} ${ref.ref}\n`));
      parts.push(pktLineDelim());
    }
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(pktLineFlush());
    sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
    return;
  }

  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktLineFlush());
  sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
}

/** v2 ls-refs: refs, HEAD symref and peeled tags, honouring ref-prefix and peel/symrefs. */
function handleLsRefs(repo: Repo, dataLines: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of dataLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = defaultBranchTip(repo);
  const emit = (oid: string, name: string, attrs: string): void => {
    if (!keep(name)) return;
    parts.push(encodePktLine(`${oid} ${name}${attrs}\n`));
  };
  if (tip) {
    if (symrefs) emit(tip, 'HEAD', ' symref-target:refs/heads/main');
    else if (keep('HEAD')) parts.push(encodePktLine(`${tip} HEAD\n`));
  }
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    let attrs = '';
    if (peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(oid, (id) => repo.objects.get(id));
        if (peeled) attrs += ` peeled:${peeled}`;
      }
    }
    emit(oid, name, attrs);
  }
  parts.push(pktLineFlush());
  sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(store: Store, owner: string, repoName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // Commands run to the flush packet; everything after it is the pack, which is
  // raw bytes — not pkt-lines — so the command section is parsed incrementally.
  const commands: PushCommand[] = [];
  let packStart = body.length;
  {
    let offset = 0;
    let malformed = false;
    while (offset + 4 <= body.length) {
      const head = body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        packStart = offset + 4;
        break;
      }
      if (head === '0001' || head === '0002') {
        offset += 4;
        continue;
      }
      const length = Number.parseInt(head, 16);
      if (!Number.isFinite(length) || length < 4 || offset + length > body.length) {
        malformed = true;
        break;
      }
      const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      const line = nul >= 0 ? text.slice(0, nul) : text;
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
      offset += length;
    }
    if (malformed) {
      sendJson(res, 400, { message: 'malformed pkt-line' });
      return;
    }
  }
  const packBytes = body.subarray(packStart);

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          repo.objectSeq.set(oid, store.nextSeq());
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        reportLines.push(`ng ${command.ref} invalid command`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (!current) reportLines.push(`ng ${command.ref} reference does not exist`);
        else if (current !== command.oldOid) reportLines.push(`ng ${command.ref} non-fast-forward`);
        else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (!target) {
        reportLines.push(`ng ${command.ref} object not found`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current) reportLines.push(`ng ${command.ref} reference already exists`);
        else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      // Update: old must match, and the new tip must descend from the old one.
      if (!current) {
        reportLines.push(`ng ${command.ref} reference does not exist`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      const newCommit = peelToCommit(command.newOid, (id) => repo.objects.get(id));
      if (!newCommit) {
        reportLines.push(`ng ${command.ref} invalid object`);
        continue;
      }
      const oldCommit = peelToCommit(current, (id) => repo.objects.get(id));
      if (!oldCommit || !store.isAncestor(repo, oldCommit, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
    repo.updatedAt = new Date().toISOString();
  }

  const text = [`unpack ${unpackDetail}`, ...reportLines].map((line) => `${line}\n`).join('');
  const report = encodePktLines(text.split('\n').filter((l) => l !== '').map((l) => `${l}\n`));
  const parts: Buffer[] = [...sidebandPackets(report), pktLineFlush()];
  sendBuffer(res, 200, Buffer.concat(parts), RECEIVE_RESULT);
}
