// MCP (Model Context Protocol) over Streamable HTTP: POST /mcp, JSON-RPC 2.0.
// Supports the modern era (2026-07-28: `server/discover`, `_meta.protocolVersion` plus the
// `MCP-Protocol-Version` header) and the legacy fallback (`initialize` +
// `notifications/initialized`, optional `Mcp-Session-Id`). The tools act on the same store as
// the REST and GraphQL surfaces, so a repo created over MCP is visible over REST and vice
// versa. Auth (Bearer token) is enforced by the app layer before this handler runs.

import { nextTimestamp, prMergeable, squashMerge, store, type PullRequest } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  body: unknown;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: {} };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };
}

// One constant definition: two tools/list calls must be byte-identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', description: 'Label names.' },
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'number', description: 'Issue number.' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['repo', 'head', 'base', 'title'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash merge onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'number', description: 'Pull request number.' },
        method: { type: 'string', description: 'Merge method: squash.' },
      },
      required: ['repo', 'number'],
    },
  },
];

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argsOf(params: unknown): Record<string, unknown> {
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const args = (params as Record<string, unknown>).arguments;
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  }
  return {};
}

function missingArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  return value === undefined || value === null || value === '';
}

function resolveRepo(args: Record<string, unknown>): { owner: string; repo: ReturnType<typeof store.getRepo> } | { error: string } {
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '') return { error: 'Missing required argument: repo' };
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return { error: `Repository not found: ${owner}/${name}` };
  const repo = store.getRepo(owner, name);
  if (!repo) return { error: `Repository not found: ${owner}/${name}` };
  return { owner, repo };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (missingArg(args, required)) {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === '.' || repoName === '..') {
      return { result: toolError(`Invalid repository name: ${repoName}`) };
    }
    if (store.getRepo(VIEWER.login, repoName)) {
      return { result: toolError(`Repository already exists: ${VIEWER.login}/${repoName}`) };
    }
    const stamp = nextTimestamp();
    const repo = store.createRepo(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true, stamp.iso);
    return { result: toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }) };
  }

  if (name === 'list_repos') {
    const repos = store.listRepos(VIEWER.login).map((repo) => ({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }));
    return { result: toolResult(repos) };
  }

  const resolved = resolveRepo(args);
  if ('error' in resolved) return { result: toolError(resolved.error) };
  const repo = resolved.repo;

  if (name === 'get_repo') {
    return { result: toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch, created_at: repo.createdAt }) };
  }

  if (name === 'create_issue') {
    const stamp = nextTimestamp();
    const issue = {
      id: repo.nextIssueId++,
      number: repo.nextIssueNumber++,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      user: VIEWER.login,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      seq: stamp.ms,
    };
    repo.issues.set(issue.number, issue);
    return { result: toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, user: { login: issue.user } }) };
  }

  if (name === 'get_issue') {
    const issue = repo.issues.get(Number(args.number));
    if (!issue) return { result: toolError(`Issue not found: #${args.number}`) };
    return { result: toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, user: { login: issue.user } }) };
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => b.number - a.number)
      .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, user: { login: issue.user } }));
    return { result: toolResult(list) };
  }

  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { result: toolError(`Head or base branch does not exist: ${head} / ${base}`) };
    const stamp = nextTimestamp();
    const pull: PullRequest = {
      id: repo.nextPullId++,
      number: repo.nextPullNumber++,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
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
    return { result: toolResult({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.head }, base: { ref: pull.base }, merged: false }) };
  }

  if (name === 'merge_pull_request') {
    const pull = repo.pulls.get(Number(args.number));
    if (!pull) return { result: toolError(`Pull request not found: #${args.number}`) };
    if (pull.state !== 'open') return { result: toolError(`Pull request #${pull.number} is not open`) };
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip || !prMergeable(repo, pull)) {
      return { result: toolError(`Pull request #${pull.number} cannot be merged: merge conflict`) };
    }
    const mergeSha = squashMerge(repo, pull);
    if (mergeSha === null) return { result: toolError(`Pull request #${pull.number} cannot be merged: merge conflict`) };
    const stamp = nextTimestamp();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = stamp.iso;
    pull.updatedAt = stamp.iso;
    return { result: toolResult({ number: pull.number, merged: true, sha: mergeSha, message: `Pull request #${pull.number} merged` }) };
  }

  return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

/** Handle one decoded JSON-RPC request object. */
export function handleMcpRequest(request: McpRequest, protocolVersion: string | null): McpResponse {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params;

  if (method === 'server/discover') {
    return rpcResult(id, { supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
  }
  if (method === 'initialize') {
    const requested = params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).protocolVersion
      : undefined;
    const version = typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    return rpcResult(id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and expects no response; a request with an id gets an empty result.
    if (id === null || id === undefined) return { status: 202, body: null };
    return rpcResult(id, {});
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // TOOLS is a module constant, so two calls serialize byte-identically.
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const paramsObj = params !== null && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    const toolName = typeof paramsObj.name === 'string' ? paramsObj.name : '';
    const outcome = callTool(toolName, argsOf(params));
    if ('error' in outcome) {
      const err = outcome.error as { code: number; message: string };
      return rpcError(id, err.code, err.message);
    }
    return rpcResult(id, outcome.result);
  }
  void protocolVersion;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle the raw POST /mcp body. Non-JSON bodies are HTTP 400 with a -32700 parse error;
 * a missing/invalid JSON-RPC object is HTTP 400 with -32600.
 */
export function handleMcpBody(raw: string, protocolVersion: string | null): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } } };
  }
  const request = parsed as McpRequest;
  if (typeof request.method !== 'string' || request.method === '') {
    return { status: 400, body: { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request: missing method' } } };
  }
  return handleMcpRequest(request, protocolVersion);
}
