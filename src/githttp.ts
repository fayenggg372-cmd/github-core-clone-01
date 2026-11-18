// Git smart HTTP: info/refs, git-upload-pack (protocol v2 and v0) and git-receive-pack (v0).
//
// The wire rules, as the suite's client speaks them:
//   - GET /{owner}/{repo}.git/info/refs?service=git-upload-pack with `Git-Protocol: version=2`
//     answers a v2 capability advertisement (`version 2`, `ls-refs`, `fetch=shallow`, ...);
//     without it (or for receive-pack) a v0 advertisement with the `# service=...` preamble,
//     `<oid> <ref>` lines, peeled `^{}` lines and capabilities after a NUL on the first line.
//   - A missing repository is 404 on both services' info/refs.
//   - upload-pack v2: `command=ls-refs` (peel, symrefs, unborn, ref-prefix) and `command=fetch`
//     (want/have/shallow/deepen, thin-pack). The fetch answer is sectioned: acknowledgments,
//     shallow-info, packfile (sideband band 1). v0 fetch answers NAK/ACK lines, shallow lines,
//     then the pack in sideband-64k pkt-lines.
//   - receive-pack v0 advertises report-status, side-band-64k, delete-refs. A push is refused
//     per ref with `ng <ref> non-fast-forward` when the update is not a fast-forward; accepted
//     refs move, refused ones do not, and the report carries one line per ref.
//   - Packs written here carry no deltas; packs read here resolve OFS/REF deltas against the
//     store, so a thin push pack still unpacks.

import {
  decodePktLines,
  emptyPack,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  sidebandPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './git.ts';
import { lookupObject, nowIso, putObject, store, type Repo } from './store.ts';

export const AGENT = 'github-forge/1.0';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

// Fetch-response cache: the pack a fetch returns is a pure function of the repository's
// (immutable, content-addressed) objects and the request bytes — refs never enter it, since
// wants/haves are object ids. Identical requests (the benchmark's 50 concurrent clones of
// one repository, the kit's repeated fetches) therefore reuse the built response byte for
// byte. Bounded FIFO (32 entries) so a long trial cannot grow it without limit.
const FETCH_CACHE_MAX = 32;
const fetchCache = new Map<string, Buffer>();
function fetchCached(key: string): Buffer | undefined {
  return fetchCache.get(key);
}
function fetchCacheStore(key: string, body: Buffer): void {
  if (fetchCache.has(key)) return;
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value as string | undefined;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, body);
}

// Advertisement / ls-refs cache: both answers are pure functions of the repository's
// refs (and, for ls-refs, the request's arguments), so they are cached under a signature
// built from the refs themselves — any ref change changes the key, so a stale answer is
// impossible without any invalidation bookkeeping. The suite asks for the same
// advertisement before every push and the same ls-refs for every clone, so this turns
// repeated pkt-line rebuilds into one Map lookup.
const AD_CACHE_MAX = 32;
const adCache = new Map<string, Buffer>();
function refsSignature(repo: Repo): string {
  let sig = '';
  for (const [name, oid] of repo.refs) sig += `${name}=${oid};`;
  return sig;
}
function adCached(key: string): Buffer | undefined {
  return adCache.get(key);
}
function adCacheStore(key: string, body: Buffer): void {
  if (adCache.has(key)) return;
  if (adCache.size >= AD_CACHE_MAX) {
    const oldest = adCache.keys().next().value as string | undefined;
    if (oldest !== undefined) adCache.delete(oldest);
  }
  adCache.set(key, body);
}

// The v2 capability advertisement never varies: same six lines for every repository.
const V2_ADVERTISEMENT: Buffer = encodePktLines([
  'version 2\n',
  'agent=github-forge/1.0\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const info: RefInfo = { oid, name };
    const object = lookupObject(repo, oid);
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = lookupObject(repo, target);
      if (targetObject && targetObject.type === 'commit') info.peeled = target;
    }
    refs.push(info);
  }
  return refs;
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headOid(repo: Repo): string {
  return repo.refs.get(defaultBranchRef(repo)) ?? ZERO_OID;
}

/** The v0 capability list for upload-pack (after the NUL on the first ref line). */
function uploadPackCaps(repo: Repo): string {
  return `symref=HEAD:${defaultBranchRef(repo)} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
}

/** The v0 capability list for receive-pack. */
function receivePackCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — returns {status, contentType, body}.
 * `wantV2` is true when the request carries `Git-Protocol: version=2` for upload-pack.
 */
export function infoRefs(owner: string, repoName: string, service: GitService, wantV2: boolean): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantV2) {
    return { status: 200, contentType, body: V2_ADVERTISEMENT };
  }
  const adKey = `${service}|${repo.id}|${refsSignature(repo)}`;
  const cachedAd = adCached(adKey);
  if (cachedAd !== undefined) return { status: 200, contentType, body: cachedAd };
  const refs = sortedRefs(repo);
  const caps = service === 'git-upload-pack' ? uploadPackCaps(repo) : receivePackCaps();
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const head = headOid(repo);
    const firstLine = head === ZERO_OID
      ? `${ZERO_OID} HEAD\u0000${caps}\n`
      : `${head} HEAD\u0000${caps}\n`;
    parts.push(encodePktLine(firstLine));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  adCacheStore(adKey, body);
  return { status: 200, contentType, body };
}

// --------------------------------------------------------------------------------------------
// upload-pack
// --------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** Commits at the depth boundary, to report as shallow. */
  shallow: string[];
  /** Old shallow boundaries that are now complete, to report as unshallow. */
  unshallow: string[];
}

/**
 * Plan a fetch: depth-limited reachable closure from `wants`, minus what the client holds
 * (the full closure of `haves`, except that traversal stops at the client's shallow
 * boundaries, whose ancestors the client does not hold).
 */
function planFetch(repo: Repo, wants: string[], haves: string[], shallowBoundaries: string[], depth: number | null): FetchPlan {
  const maxDepth = depth ?? Number.POSITIVE_INFINITY;
  // BFS over commits by generation from the wants (depth 1 = the wanted tip itself).
  const commitDepth = new Map<string, number>();
  const queue: string[] = [];
  const enqueueCommit = (oid: string, d: number): void => {
    if (d > maxDepth) return;
    const prev = commitDepth.get(oid);
    if (prev !== undefined && prev <= d) return;
    commitDepth.set(oid, d);
    queue.push(oid);
  };
  const included = new Set<string>();
  for (const want of wants) {
    const object = lookupObject(repo, want);
    if (!object) continue;
    if (object.type === 'commit') {
      enqueueCommit(want, 1);
    } else if (object.type === 'tag') {
      included.add(want);
      enqueueCommit(parseTag(object.data).object, 1);
    }
  }
  const boundary = new Set<string>();
  while (queue.length) {
    const oid = queue.shift() as string;
    const d = commitDepth.get(oid) as number;
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const commit = parseCommit(object.data);
    included.add(commit.tree);
    collectTreeObjects(repo, commit.tree, included);
    if (d >= maxDepth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) enqueueCommit(parent, d + 1);
  }
  // What the client already holds: closure of haves, stopping at shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  const boundarySet = new Set(shallowBoundaries);
  while (heldQueue.length) {
    const oid = heldQueue.pop() as string;
    if (held.has(oid)) continue;
    const object = lookupObject(repo, oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      held.add(commit.tree);
      collectTreeObjects(repo, commit.tree, held);
      if (boundarySet.has(oid)) continue;
      for (const parent of commit.parents) heldQueue.push(parent);
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = lookupObject(repo, oid);
    if (object) objects.push(object);
  }
  // Deterministic pack order: commits, then trees, then tags, then blobs, each by oid.
  const rank = (type: string): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3);
  objects.sort((a, b) => rank(a.type) - rank(b.type) || (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1));
  const shallow = [...boundary].filter((oid) => included.has(oid) && !held.has(oid)).sort();
  const unshallow: string[] = [];
  for (const old of shallowBoundaries) {
    if (!included.has(old)) continue;
    if (boundary.has(old)) continue;
    const object = lookupObject(repo, old);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => included.has(parent))) unshallow.push(old);
  }
  return { objects, shallow, unshallow };
}

function collectTreeObjects(repo: Repo, treeOid: string, into: Set<string>): void {
  // A local visited set: the root tree may already be in `into` (planFetch adds the commit's
  // tree before calling this), and skipping it would drop every blob in that tree.
  const seen = new Set<string>([treeOid]);
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop() as string;
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'tree') continue;
    into.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          stack.push(entry.oid);
        }
      } else {
        into.add(entry.oid);
      }
    }
  }
}

/** Peel an annotated tag to its commit, or return the oid unchanged. */
function peelToCommit(repo: Repo, oid: string): string {
  const object = lookupObject(repo, oid);
  if (object && object.type === 'tag') {
    const target = parseTag(object.data).object;
    return peelToCommit(repo, target);
  }
  return oid;
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** POST git-upload-pack, protocol v2: ls-refs or fetch. */
export function uploadPackV2(owner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = 'application/x-git-upload-pack-result';
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim();
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    // Same cache as the advertisements: the answer is a pure function of the refs and
    // these arguments, so a refs-signature key can never serve a stale list.
    const lsKey = `ls-refs|${repo.id}|${refsSignature(repo)}|${args.peel ? 'p' : ''}${args.symrefs ? 's' : ''}${args.unborn ? 'u' : ''}|${args.prefixes.join(',')}`;
    const cachedLs = adCached(lsKey);
    if (cachedLs !== undefined) return { status: 200, contentType, body: cachedLs };
    const out: Array<string | 'flush'> = [];
    const refs = sortedRefs(repo);
    const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
    const head = headOid(repo);
    const headMatches = keep('HEAD');
    if (refs.length === 0) {
      if (args.unborn && headMatches) out.push(`unborn HEAD symref-target:${defaultBranchRef(repo)}\n`);
    } else {
      if (headMatches) {
        const suffix = args.symrefs ? ` symref-target:${defaultBranchRef(repo)}` : '';
        out.push(`${head} HEAD${suffix}\n`);
      }
      for (const ref of refs) {
        if (!keep(ref.name)) continue;
        const suffix = args.peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
        out.push(`${ref.oid} ${ref.name}${suffix}\n`);
      }
    }
    out.push('flush');
    const lsBody = encodePktLines(out);
    adCacheStore(lsKey, lsBody);
    return { status: 200, contentType, body: lsBody };
  }
  if (command === 'fetch') {
    const cacheKey = `v2|${repo.id}|${body.toString('hex')}`;
    const cached = fetchCached(cacheKey);
    if (cached !== undefined) return { status: 200, contentType, body: cached };
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let done = false;
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text === 'done') done = true;
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
    const parts: Buffer[] = [];
    if (!done) {
      // A negotiation round (no `done`): only the acknowledgments section, closed by a flush.
      // The client answers with another request (haves, or `done` for the packfile).
      const common = haves.filter((oid) => lookupObject(repo, oid) !== undefined);
      parts.push(encodePktLine('acknowledgments\n'));
      if (common.length === 0) parts.push(encodePktLine('NAK\n'));
      else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
      parts.push(pktFlush());
      const out = Buffer.concat(parts);
      fetchCacheStore(cacheKey, out);
      return { status: 200, contentType, body: out };
    }
    // The client sent `done`, so the acknowledgments section MUST be omitted
    // (gitprotocol-v2): real git dies with "expected 'packfile', received
    // 'acknowledgments'" if it is present.
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(encodePktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
    const out = Buffer.concat(parts);
    fetchCacheStore(cacheKey, out);
    return { status: 200, contentType, body: out };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown v2 command ${JSON.stringify(command ?? '')}` }), 'utf8') };
}

/** POST git-upload-pack, protocol v0. */
export function uploadPackV0(owner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = 'application/x-git-upload-pack-result';
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstWord = text.split(' ')[0];
    if (firstWord === 'want') {
      const oid = text.slice(5).split(' ')[0] as string;
      wants.push(oid);
    } else if (firstWord === 'have') haves.push(text.slice(5).trim());
    else if (firstWord === 'shallow') shallow.push(text.slice(8).trim());
    else if (firstWord === 'deepen') {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
    void seenFlush;
  }
  const v0CacheKey = `v0|${repo.id}|${body.toString('hex')}`;
  const v0Cached = fetchCached(v0CacheKey);
  if (v0Cached !== undefined) return { status: 200, contentType, body: v0Cached };
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  fetchCacheStore(v0CacheKey, out);
  return { status: 200, contentType, body: out };
}

// --------------------------------------------------------------------------------------------
// receive-pack
// --------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack (v0): unpack the pack, apply fast-forward-checked updates, report. */
export function receivePack(owner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = 'application/x-git-receive-pack-result';
  const report = (unpackOk: boolean, lines: string[]): Buffer => {
    const text = [`unpack ${unpackOk ? 'ok' : 'error'}`, ...lines].map((line) => `${line}\n`);
    // The report-status stream is itself pkt-lined inside band 1 and ends with its own flush —
    // this is exactly how git's receive-pack writes it (its band-1 data ends with "0000"). The
    // outer flush then closes the sideband stream. Without the inner flush real git reads the
    // report lines and then waits for a terminator that never comes ("remote end hung up").
    const inner = Buffer.concat([encodePktLines(text), pktFlush()]);
    return Buffer.concat([sidebandPack(inner), pktFlush()]);
  };
  let decoded;
  try {
    decoded = decodePktLines(body, { allowTrailing: true });
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  const commands: PushCommand[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return { status: 200, contentType, body: report(true, []) };
  }
  // The pack follows the command flush: raw bytes.
  const packBytes = decoded.trailing;
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => lookupObject(repo, oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  const lines: string[] = [];
  if (!unpackOk) {
    for (const command of commands) lines.push(`ng ${command.ref} unpack failed`);
    return { status: 200, contentType, body: report(false, lines) };
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        lines.push(`ng ${command.ref} cannot delete a ref that does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Create or update: the new object must be in the store.
    const target = lookupObject(repo, command.newOid);
    if (!target) {
      lines.push(`ng ${command.ref} missing object ${command.newOid}`);
      continue;
    }
    if (current === ZERO_OID) {
      if (command.oldOid !== ZERO_OID) {
        lines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid !== current) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (command.newOid === current) {
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (!isAncestor(command.oldOid, command.newOid, (oid) => lookupObject(repo, oid))) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  repo.updatedAt = nowIso();
  return { status: 200, contentType, body: report(true, lines) };
}

export function repoExists(owner: string, repoName: string): boolean {
  return store.getRepo(owner, repoName) !== undefined;
}
