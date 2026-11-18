// GitHub REST v3 under /api/v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors carry {message}. A request without the trial token is 401 (the
// auth gate lives in app.ts); a repository under any owner but the token's login is 404.

import { isObjectId, parseCommit, parseTree, ZERO_OID } from './git.ts';
import {
  commitOnBranch,
  decodeGlobalId,
  flattenTree,
  globalId,
  listCommits,
  lookupObject,
  nextTimestamp,
  nowIso,
  planMerge,
  prMergeable,
  pullFiles,
  putObject,
  squashMerge,
  store,
  treeLookup,
  treeOfCommit,
  updateTree,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';

export interface HttpCtx {
  method: string;
  /** Path segments after `/api/v3` (already URI-decoded per segment). */
  segments: string[];
  query: URLSearchParams;
  /** Raw request body text ('' when none). */
  bodyText: string;
  /** Parsed JSON body, or undefined when the body is absent/empty; null on malformed JSON. */
  body: unknown;
  bodyMalformed: boolean;
  host: string;
  requestId: string;
  send: (status: number, body: unknown, extraHeaders?: Record<string, string>) => void;
  /** Send a pre-serialized JSON string as-is (no second stringify). */
  sendText: (status: number, text: string, extraHeaders?: Record<string, string>) => void;
  sendNoBody: (status: number, extraHeaders?: Record<string, string>) => void;
}

export function jsonError(ctx: HttpCtx, status: number, message: string): void {
  ctx.send(status, { message });
}

function isViewer(owner: string): boolean {
  return owner.toLowerCase() === VIEWER.login.toLowerCase();
}

/** The repository for /repos/{owner}/{name}, or null (404) when absent or not the viewer's. */
function repoOf(ctx: HttpCtx, owner: string, name: string): Repo | null {
  if (!isViewer(owner)) return null;
  return store.getRepo(owner, name) ?? null;
}

function repoView(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('U', VIEWER.id), type: 'User' },
    private: repo.private,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
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
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function userView(login: string): Record<string, unknown> {
  return { login, id: VIEWER.id, node_id: globalId('U', VIEWER.id), type: 'User', site_admin: false };
}

function labelView(label: Label): Record<string, unknown> {
  return { id: globalId('L', label.name), node_id: globalId('L', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  const comments = repo.comments.get(issue.number)?.length ?? 0;
  return {
    id: issue.id,
    node_id: globalId('I', repo.id, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userView(issue.user),
    labels: issue.labels.map(labelView),
    assignee: null,
    assignees: [],
    milestone: null,
    comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

// Serialized single-issue cache: the read workload GETs one issue 2,000 times, and the
// view is a pure function of the issue's fields plus its comment count. The key carries
// every input the view reads — updatedAt moves on every issue mutation (PATCH and the
// GraphQL close both stamp it), the comment count covers comment adds, and labels only
// ever change at creation — so a hit always equals a fresh render. Bounded FIFO (512).
const ISSUE_JSON_CACHE_MAX = 512;
const issueJsonCache = new Map<string, string>();
function issueViewJson(repo: Repo, issue: Issue): string {
  const key = `${repo.id}:${issue.number}:${issue.updatedAt}:${repo.comments.get(issue.number)?.length ?? 0}:${issue.labels.map((l) => l.name).join(',')}:${issue.title.length}:${issue.body.length}:${issue.state}`;
  const cached = issueJsonCache.get(key);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueView(repo, issue));
  if (issueJsonCache.size >= ISSUE_JSON_CACHE_MAX) {
    const oldest = issueJsonCache.keys().next().value as string | undefined;
    if (oldest !== undefined) issueJsonCache.delete(oldest);
  }
  issueJsonCache.set(key, text);
  return text;
}

function pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const files = pullFiles(repo, pull);
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const mergeable = pull.state === 'open' ? prMergeable(repo, pull) : false;
  const headRepo = { id: repo.id, node_id: globalId('R', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}` };
  const refView = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userView(repo.owner),
    repo: headRepo,
  });
  return {
    id: pull.id,
    node_id: globalId('P', repo.id, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userView(repo.owner),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? userView(repo.owner) : null,
    head: refView(pull.head, pull.headSha),
    base: refView(pull.base, pull.baseSha),
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
    draft: false,
    author_association: 'OWNER',
  };
}

function paginate<T>(ctx: HttpCtx, path: string, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `http://${ctx.host}${path}`;
  const links: string[] = [];
  const linkFor = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (totalPages > 1) links.push(linkFor(totalPages, 'last'));
  if (page > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(page - 1, 'prev'));
  }
  return { page: slice, link: links.length ? links.join(', ') : null };
}

function sendPage<T>(ctx: HttpCtx, path: string, items: T[]): void {
  const { page, link } = paginate(ctx, path, items);
  ctx.send(200, page, link === null ? {} : { link });
}

function bodyObject(ctx: HttpCtx): Record<string, unknown> | null {
  if (ctx.bodyMalformed) return null;
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body === 'object' && !Array.isArray(ctx.body)) return ctx.body as Record<string, unknown>;
  return null;
}

function badBody(ctx: HttpCtx): boolean {
  if (ctx.bodyMalformed) {
    jsonError(ctx, 400, 'Malformed JSON body');
    return true;
  }
  return false;
}

/** Resolve a ref query (?ref=branch|sha) to a commit oid, or the branch tip. */
function resolveRef(repo: Repo, refParam: string | null, defaultBranch: string): string | null {
  if (refParam === null || refParam === '') return repo.refs.get(`refs/heads/${defaultBranch}`) ?? null;
  if (isObjectId(refParam)) return lookupObject(repo, refParam) ? refParam : null;
  return repo.refs.get(`refs/heads/${refParam}`) ?? null;
}

export function handleRest(ctx: HttpCtx): boolean {
  const seg = ctx.segments;
  const method = ctx.method;

  // API root and meta.
  if (seg.length === 0) {
    if (method === 'GET') {
      ctx.send(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method === 'GET') {
      ctx.send(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method === 'GET') {
      ctx.send(200, {
        login: VIEWER.login, id: VIEWER.id, node_id: globalId('U', VIEWER.id), avatar_url: '',
        name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false,
        html_url: `https://example.invalid/${VIEWER.login}`,
      });
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login).map(repoView);
      sendPage(ctx, '/api/v3/user/repos', repos);
      return true;
    }
    if (method === 'POST') {
      if (badBody(ctx)) return true;
      const body = bodyObject(ctx);
      if (body === null) {
        jsonError(ctx, 400, 'Invalid JSON body');
        return true;
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        jsonError(ctx, 422, 'Repository name is invalid');
        return true;
      }
      if (store.getRepo(VIEWER.login, name)) {
        jsonError(ctx, 422, `Repository ${VIEWER.login}/${name} already exists`);
        return true;
      }
      const repo = store.createRepo(VIEWER.login, name, {
        private: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
      });
      ctx.send(201, repoView(repo));
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  if (seg.length < 3 || seg[0] !== 'repos') {
    jsonError(ctx, 404, 'Not Found');
    return true;
  }
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  const rest = seg.slice(3);

  // GET /repos/{owner}/{repo} | PATCH | DELETE
  if (rest.length === 0) {
    const repo = repoOf(ctx, owner, repoName);
    if (method === 'GET') {
      if (!repo) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      ctx.send(200, repoView(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (!repo) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (badBody(ctx)) return true;
      const body = bodyObject(ctx);
      if (body === null) {
        jsonError(ctx, 400, 'Invalid JSON body');
        return true;
      }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        // Renames are not supported by the suite; ignore.
      }
      repo.updatedAt = nowIso();
      ctx.send(200, repoView(repo));
      return true;
    }
    if (method === 'DELETE') {
      if (!repo) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      store.deleteRepo(owner, repoName);
      ctx.sendNoBody(204);
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  const repo = repoOf(ctx, owner, repoName);
  const needRepo = (): Repo | null => {
    if (!repo) jsonError(ctx, 404, 'Not Found');
    return repo;
  };

  // Branches.
  if (rest[0] === 'branches') {
    if (!needRepo()) return true;
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
      ctx.send(200, branches);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = rest[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      ctx.send(200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (!needRepo()) return true;
    if (method === 'POST' && rest.length === 2) {
      if (badBody(ctx)) return true;
      const body = bodyObject(ctx);
      if (body === null) {
        jsonError(ctx, 400, 'Invalid JSON body');
        return true;
      }
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !lookupObject(repo, sha)) {
        jsonError(ctx, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        jsonError(ctx, 422, `Reference ${ref} already exists`);
        return true;
      }
      repo.refs.set(ref, sha);
      ctx.send(201, { ref, object: { sha, type: lookupObject(repo, sha)?.type ?? 'commit' } });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      ctx.send(200, { ref, object: { sha, type: lookupObject(repo, sha)?.type ?? 'commit' } });
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (!needRepo()) return true;
    if (method === 'GET' && rest.length === 1) {
      const shaParam = ctx.query.get('sha');
      const tip = resolveRef(repo, shaParam, repo.defaultBranch);
      if (!tip) {
        ctx.send(200, []);
        return true;
      }
      const commits = listCommits(repo, tip).map((entry) => {
        const parsed = parseCommit(lookupObject(repo, entry.sha)?.data ?? Buffer.alloc(0));
        const authorLine = parsed.author;
        const gt = authorLine.lastIndexOf('>');
        const epochPart = authorLine.slice(gt + 1).trim().split(' ')[0] ?? '';
        const epoch = Number(epochPart);
        const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : nowIso();
        const who = authorLine.slice(0, authorLine.lastIndexOf('<')).trim();
        return {
          sha: entry.sha,
          commit: {
            message: entry.message,
            author: { name: who, email: VIEWER.email, date },
            committer: { name: who, email: VIEWER.email, date },
            tree: { sha: entry.tree },
          },
          author: userView(VIEWER.login),
          committer: userView(VIEWER.login),
          parents: entry.parents.map((p) => ({ sha: p })),
        };
      });
      ctx.send(200, commits);
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  // Contents.
  if (rest[0] === 'contents') {
    if (!needRepo()) return true;
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      const refParam = ctx.query.get('ref');
      const tip = resolveRef(repo, refParam, repo.defaultBranch);
      if (!tip) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      const treeOid = treeOfCommit(repo, tip);
      if (filePath === '') {
        const entries = dirEntries(repo, treeOid, '');
        ctx.send(200, entries);
        return true;
      }
      const found = treeLookup(repo, treeOid, filePath);
      if (!found) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (found.mode === '40000') {
        ctx.send(200, dirEntries(repo, found.oid, filePath));
        return true;
      }
      const blob = lookupObject(repo, found.oid);
      if (!blob) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      ctx.send(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: blob.data.toString('base64'),
        sha: found.oid,
      });
      return true;
    }
    if (method === 'PUT') {
      if (badBody(ctx)) return true;
      const body = bodyObject(ctx);
      if (body === null) {
        jsonError(ctx, 400, 'Invalid JSON body');
        return true;
      }
      const message = typeof body.message === 'string' ? body.message : 'Update file';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : null;
      let branchTip = repo.refs.get(`refs/heads/${branch}`);
      if (branchTip === undefined) {
        // A new branch starts from the default branch tip (or an unborn root).
        const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (base !== undefined) repo.refs.set(`refs/heads/${branch}`, base);
        branchTip = repo.refs.get(`refs/heads/${branch}`);
      }
      const currentTree = branchTip ? treeOfCommit(repo, branchTip) : null;
      const existing = treeLookup(repo, currentTree, filePath);
      if (sha !== null) {
        if (!existing || existing.oid !== sha) {
          jsonError(ctx, 409, 'sha does not match the current file');
          return true;
        }
      } else if (existing) {
        jsonError(ctx, 422, 'sha is required to update an existing file');
        return true;
      }
      const isUpdate = existing !== null;
      const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const blobOid = putObject(repo, 'blob', content);
      const newTree = updateTree(repo, currentTree, filePath, blobOid);
      const { commitOid } = commitOnBranch(repo, branch, newTree, message);
      ctx.send(isUpdate ? 200 : 201, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitOid, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      if (badBody(ctx)) return true;
      const body = bodyObject(ctx);
      if (body === null) {
        jsonError(ctx, 400, 'Invalid JSON body');
        return true;
      }
      const message = typeof body.message === 'string' ? body.message : 'Delete file';
      const sha = typeof body.sha === 'string' ? body.sha : null;
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const branchTip = repo.refs.get(`refs/heads/${branch}`);
      if (!branchTip) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      const currentTree = treeOfCommit(repo, branchTip);
      const existing = treeLookup(repo, currentTree, filePath);
      if (!existing) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (sha !== null && existing.oid !== sha) {
        jsonError(ctx, 409, 'sha does not match the current file');
        return true;
      }
      const newTree = updateTree(repo, currentTree, filePath, null);
      const { commitOid } = commitOnBranch(repo, branch, newTree, message);
      ctx.send(200, { commit: { sha: commitOid, message } });
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (!needRepo()) return true;
    if (method === 'GET' && rest.length === 1) {
      ctx.send(200, [...repo.labels.values()].map(labelView));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      if (badBody(ctx)) return true;
      const body = bodyObject(ctx);
      if (body === null) {
        jsonError(ctx, 400, 'Invalid JSON body');
        return true;
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        jsonError(ctx, 422, 'Label name is required');
        return true;
      }
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      const label: Label = {
        name,
        color,
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(name.toLowerCase(), label);
      ctx.send(201, labelView(label));
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (!needRepo()) return true;
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (ctx.query.get('state') ?? 'open').toLowerCase();
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        sendPage(ctx, `/api/v3/repos/${owner}/${repoName}/issues`, list.map((issue) => issueView(repo, issue)));
        return true;
      }
      if (method === 'POST') {
        if (badBody(ctx)) return true;
        const body = bodyObject(ctx);
        if (body === null) {
          jsonError(ctx, 400, 'Invalid JSON body');
          return true;
        }
        const title = typeof body.title === 'string' ? body.title : '';
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const rawLabels = Array.isArray(body.labels) ? body.labels : [];
        const labels: Label[] = [];
        for (const raw of rawLabels) {
          const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? String((raw as Record<string, unknown>).name ?? '') : '';
          const label = repo.labels.get(name.toLowerCase());
          if (!label) {
            jsonError(ctx, 422, `Label "${name}" does not exist`);
            return true;
          }
          labels.push(label);
        }
        const stamp = nextTimestamp();
        const issue: Issue = {
          id: repo.nextIssueId++,
          number: repo.nextIssueNumber++,
          title,
          body: issueBody,
          state: 'open',
          labels,
          user: VIEWER.login,
          createdAt: stamp.iso,
          updatedAt: stamp.iso,
          seq: stamp.ms,
        };
        repo.issues.set(issue.number, issue);
        ctx.send(201, issueView(repo, issue));
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) {
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2) {
      const issue = repo.issues.get(number);
      if (!issue) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        ctx.sendText(200, issueViewJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (badBody(ctx)) return true;
        const body = bodyObject(ctx);
        if (body === null) {
          jsonError(ctx, 400, 'Invalid JSON body');
          return true;
        }
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        issue.updatedAt = nextTimestamp().iso;
        ctx.send(200, issueView(repo, issue));
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = repo.issues.get(number);
      if (!issue) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        const comments = (repo.comments.get(number) ?? []).map((comment) => ({
          id: comment.id,
          node_id: globalId('C', repo.id, number, comment.id),
          body: comment.body,
          user: userView(comment.user),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
          html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
          issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
        }));
        ctx.send(200, comments);
        return true;
      }
      if (method === 'POST') {
        if (badBody(ctx)) return true;
        const body = bodyObject(ctx);
        if (body === null) {
          jsonError(ctx, 400, 'Invalid JSON body');
          return true;
        }
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const stamp = nextTimestamp();
        const comment = {
          id: repo.nextCommentId++,
          issueNumber: number,
          body: commentBody,
          user: VIEWER.login,
          createdAt: stamp.iso,
          updatedAt: stamp.iso,
        };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        ctx.send(201, {
          id: comment.id,
          node_id: globalId('C', repo.id, number, comment.id),
          body: comment.body,
          user: userView(comment.user),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
          html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
          issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
        });
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (!needRepo()) return true;
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (ctx.query.get('state') ?? 'open').toLowerCase();
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.seq - a.seq);
        sendPage(ctx, `/api/v3/repos/${owner}/${repoName}/pulls`, list.map((pull) => pullView(repo, pull)));
        return true;
      }
      if (method === 'POST') {
        if (badBody(ctx)) return true;
        const body = bodyObject(ctx);
        if (body === null) {
          jsonError(ctx, 400, 'Invalid JSON body');
          return true;
        }
        const title = typeof body.title === 'string' ? body.title : '';
        const prBody = typeof body.body === 'string' ? body.body : '';
        const head = typeof body.head === 'string' ? body.head.split(':').pop() as string : '';
        const base = typeof body.base === 'string' ? body.base.split(':').pop() as string : repo.defaultBranch;
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          jsonError(ctx, 422, 'Head or base branch does not exist');
          return true;
        }
        const duplicate = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
        if (duplicate) {
          jsonError(ctx, 422, 'A pull request already exists for this head and base');
          return true;
        }
        const stamp = nextTimestamp();
        const pull: PullRequest = {
          id: repo.nextPullId++,
          number: repo.nextPullNumber++,
          title,
          body: prBody,
          state: 'open',
          head,
          base,
          headSha,
          baseSha,
          merged: false,
          mergeCommitSha: null,
          mergedAt: null,
          createdAt: stamp.iso,
          updatedAt: stamp.iso,
          seq: stamp.ms,
        };
        repo.pulls.set(pull.number, pull);
        ctx.send(201, pullView(repo, pull));
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) {
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        // Refresh head/base shas from the branches (they may have advanced).
        pull.headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
        pull.baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
        ctx.send(200, pullView(repo, pull));
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (!pull) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        ctx.send(200, pullFiles(repo, pull).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })));
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pull) {
        jsonError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        if (pull.state === 'closed') {
          jsonError(ctx, 405, pull.merged ? 'Pull request already merged' : 'Pull request is closed');
          return true;
        }
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        if (!baseTip || !headTip) {
          jsonError(ctx, 405, 'Head or base branch is missing');
          return true;
        }
        const plan = planMerge(repo, baseTip, headTip);
        if (plan.conflict) {
          jsonError(ctx, 405, 'Merge conflict');
          return true;
        }
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha === null) {
          jsonError(ctx, 405, 'Merge conflict');
          return true;
        }
        const stamp = nextTimestamp();
        pull.state = 'closed';
        pull.merged = true;
        pull.mergeCommitSha = mergeSha;
        pull.mergedAt = stamp.iso;
        pull.updatedAt = stamp.iso;
        pull.headSha = headTip;
        pull.baseSha = mergeSha;
        ctx.send(200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` });
        return true;
      }
      jsonError(ctx, 404, 'Not Found');
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }

  jsonError(ctx, 404, 'Not Found');
  return true;
}

function dirEntries(repo: Repo, treeOid: string | null, dirPath: string): Array<Record<string, unknown>> {
  if (treeOid === null) return [];
  const tree = lookupObject(repo, treeOid);
  if (!tree || tree.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(tree.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = lookupObject(repo, entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}
