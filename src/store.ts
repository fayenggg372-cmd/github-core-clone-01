// The forge's store: one in-memory state per process, shared by git smart HTTP, REST v3,
// GraphQL v4 and MCP. A trial runs one process in a fresh pod, so the store lives exactly as
// long as the trial; nothing is read from or written to disk on the request path (the timed
// workloads are pure memory operations). All timestamps come from a logical clock seeded from
// MAKEFUN_TRIAL_NOW, never the wall clock, so two runs of the same trial produce byte-identical
// commits and records.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';
import { VIEWER } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';

/** The trial's logical "now": MAKEFUN_TRIAL_NOW (ms) or the scenario epoch, stepped +1s per event. */
const EPOCH_MS = Number(process.env.MAKEFUN_TRIAL_NOW ?? '') || 1735689600000;
let clockMs = EPOCH_MS;

export function nextTimestamp(): { ms: number; iso: string; epochSec: number } {
  clockMs += 1000;
  const ms = clockMs;
  return { ms, iso: new Date(ms).toISOString(), epochSec: Math.floor(ms / 1000) };
}

export function nowIso(): string {
  return new Date(clockMs).toISOString();
}

/** Opaque, stable Relay-style global ids (never the plain database id or number). */
export const globalId = (kind: string, ...parts: Array<string | number>): string =>
  Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface Label {
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
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  nextIssueId: number;
  pulls: Map<number, PullRequest>;
  nextPullNumber: number;
  nextPullId: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
}

class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const stamp = nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      seq: this.nextSeq++,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      nextIssueId: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      nextPullId: 1,
      labels: new Map(),
      comments: new Map(),
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

export const store = new Store();

export function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The identity REST-created commits and merges carry. */
export function forgeIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/**
 * Return a new tree oid: `rootTreeOid`'s tree with `path` set to `blobOid` (or removed when
 * `blobOid` is null), rebuilding every ancestor tree. Intermediate directories are created.
 */
export function updateTree(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new Error('empty path');
  const build = (treeOid: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const tree = lookupObject(repo, treeOid);
      if (!tree || tree.type !== 'tree') throw new Error('missing tree object');
      for (const entry of parseTree(tree.data)) entries.set(entry.name, entry);
    }
    const segment = segments[depth] as string;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(segment);
      else entries.set(segment, { mode: '100644', name: segment, oid: blobOid });
    } else {
      const child = entries.get(segment);
      const childOid = build(child && child.mode === '40000' ? child.oid : null, depth + 1);
      const childTree = lookupObject(repo, childOid);
      if (!childTree || parseTree(childTree.data).length === 0) entries.delete(segment);
      else entries.set(segment, { mode: '40000', name: segment, oid: childOid });
    }
    return putObject(repo, 'tree', buildTree([...entries.values()]));
  };
  return build(rootTreeOid, 0);
}

/** The blob oid and tree entries at `path` in the tree `rootTreeOid` (null when absent). */
export function treeLookup(repo: Repo, rootTreeOid: string | null, path: string): { oid: string; mode: string } | null {
  if (rootTreeOid === null) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let current = rootTreeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const tree = lookupObject(repo, current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[depth]);
    if (!entry) return null;
    if (depth === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode} for every file (not directories). */
export function flattenTree(repo: Repo, rootTreeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const tree = lookupObject(repo, treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (rootTreeOid !== null) walk(rootTreeOid, '');
  return out;
}

/** The tip commit's tree oid for a ref, or null when the ref is unborn. */
export function refTree(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (!oid || oid === ZERO_OID) return null;
  const object = lookupObject(repo, oid);
  if (!object) return null;
  if (object.type === 'commit') return parseCommit(object.data).tree;
  if (object.type === 'tag') {
    const target = lookupObject(repo, parseTag(object.data).object);
    if (target && target.type === 'commit') return parseCommit(target.data).tree;
  }
  return null;
}

/** Create a commit object on `branch` (creating the branch when needed). */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): { commitOid: string; parent: string | null } {
  const parent = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const stamp = nextTimestamp();
  const identity = forgeIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents: parent && parent !== ZERO_OID ? [parent] : [],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: identity,
    committer: identity,
    timestamp: stamp.epochSec,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = stamp.iso;
  return { commitOid, parent };
}

/** The merge-base of two commits: the first common ancestor found by BFS from both sides. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const object = lookupObject(repo, oid);
    if (object && object.type === 'commit') queueA.push(...parseCommit(object.data).parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (fromA.has(oid)) return oid;
    const object = lookupObject(repo, oid);
    if (object && object.type === 'commit') queueB.push(...parseCommit(object.data).parents);
  }
  return null;
}

export interface MergePlan {
  conflict: boolean;
  conflictPaths: string[];
  treeOid: string;
}

/**
 * A three-way file-level merge: base tree, head tree, onto the current base-tip tree.
 * A path conflicts when both sides changed it differently since the merge-base.
 */
export function planMerge(repo: Repo, baseTip: string, headTip: string): MergePlan {
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  const ontoTree = treeOfCommit(repo, baseTip);
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const ontoFiles = flattenTree(repo, ontoTree);
  const conflicts: string[] = [];
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ontoFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const o = ontoFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, o)) {
      if (h) merged.set(path, h);
    } else if (same(b, o)) {
      if (h) merged.set(path, h);
    } else if (same(b, h)) {
      if (o) merged.set(path, o);
    } else {
      conflicts.push(path);
      if (o) merged.set(path, o);
    }
  }
  // Rebuild the merged tree from the flat map.
  const buildFromFlat = (files: Map<string, { oid: string; mode: string }>): string => {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const buildNode = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(child) });
      return putObject(repo, 'tree', buildTree(entries));
    };
    return buildNode(root);
  };
  return { conflict: conflicts.length > 0, conflictPaths: conflicts, treeOid: buildFromFlat(merged) };
}

/** The tree oid of a commit (or the target of an annotated tag), or null. */
export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = lookupObject(repo, commitOid);
  if (!object) return null;
  if (object.type === 'commit') return parseCommit(object.data).tree;
  if (object.type === 'tag') {
    const target = lookupObject(repo, parseTag(object.data).object);
    if (target && target.type === 'commit') return parseCommit(target.data).tree;
  }
  return null;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid or null on conflict. */
export function squashMerge(repo: Repo, pull: PullRequest): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip || baseTip === ZERO_OID || headTip === ZERO_OID) return null;
  const plan = planMerge(repo, baseTip, headTip);
  if (plan.conflict) return null;
  const stamp = nextTimestamp();
  const identity = forgeIdentity();
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
  const commit = buildCommit({
    tree: plan.treeOid,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: stamp.epochSec,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  repo.updatedAt = stamp.iso;
  return commitOid;
}

/** Whether a pull request would merge cleanly right now. */
export function prMergeable(repo: Repo, pull: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip || baseTip === ZERO_OID || headTip === ZERO_OID) return false;
  return !planMerge(repo, baseTip, headTip).conflict;
}

/** Files changed between the merge-base tree and the head tree, with line counts. */
export function pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  const before = flattenTree(repo, baseTree);
  const after = flattenTree(repo, headTree);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const countLines = (oid: string): number => {
    const object = lookupObject(repo, oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b && !a) {
      const deletions = countLines(b.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && a) {
      const additions = countLines(a.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && a && b.oid !== a.oid) {
      const additions = countLines(a.oid);
      const deletions = countLines(b.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Commits reachable from `tip`, newest first (BFS by generation, parents after children). */
export function listCommits(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string; parents: string[]; tree: string }> {
  const out: Array<{ sha: string; message: string; parents: string[]; tree: string }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, parents: commit.parents, tree: commit.tree });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** Is `oid` an ancestor-or-self of `tip`? */
export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  return isAncestor(oldOid, newOid, (oid) => lookupObject(repo, oid));
}

export function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  return collectReachable(roots, (oid) => lookupObject(repo, oid));
}
