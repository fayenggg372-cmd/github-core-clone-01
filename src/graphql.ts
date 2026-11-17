// GitHub GraphQL v4, minimal executor for exactly the documents gh and github-mcp-server
// send (see the kit's checks-graphql.ts): viewer, repository reads, __type introspection,
// issue/pull-request reads and the create/close/merge/addComment mutations, plus batched
// operation arrays. A hand-rolled parser (no dependency) validates field names against the
// schema: an unknown field is HTTP 200 with an `errors` array naming it. An unknown
// repository reads `data.repository = null` with no errors. Global ids are opaque base64.

import { nextTimestamp, planMerge, prMergeable, pullFiles, squashMerge, store, type Issue, type PullRequest, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';
import { decodeGlobalId, globalId } from './store.ts';

// --------------------------------------------------------------------------------------------
// parser
// --------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface Selection {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[] | null;
  /** Inline fragment: `... on Type { ... }` — applies when the parent type matches. */
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: Selection[];
}

class ParseError extends Error {}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== null) {
      const token = this.next();
      if (token === 'query' || token === 'mutation') {
        let name: string | null = null;
        if (this.peek() !== null && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') {
          name = this.next();
        }
        // Variable definitions: ($name: Type = default, ...).
        if (this.peek() === '(') {
          this.next();
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t === '(' || t === '[' || t === '{') depth += 1;
            if (t === ')' || t === ']' || t === '}') depth -= 1;
          }
        }
        const selections = this.parseSelectionSet();
        operations.push({ kind: token as 'query' | 'mutation', name, variables: {}, selections });
      } else if (token === '{') {
        this.pos -= 1;
        operations.push({ kind: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        if (this.peek() === 'on') this.next();
        this.next();
        this.parseSelectionSet();
      } else {
        throw new ParseError(`unexpected token ${token}`);
      }
    }
    return operations;
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === null) throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selections, fragmentType };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    // Directives (@...) are ignored.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t === '(' || t === '[' || t === '{') depth += 1;
          if (t === ')' || t === ']' || t === '}') depth -= 1;
        }
      }
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, fragmentType: null };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------------------------
// schema
// --------------------------------------------------------------------------------------------

/** Field name -> return type for validation and nested execution. */
const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: 'String', url: 'String', createdAt: 'String',
    updatedAt: 'String', isPrivate: 'Boolean',
  },
  Ref: { name: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String',
    url: 'String', createdAt: 'String', updatedAt: 'String', closedAt: 'String',
    author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository',
  },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', mergeable: 'MergeableState', headRefName: 'String', baseRefName: 'String',
    headRefOid: 'String', baseRefOid: 'String', files: 'PullRequestChangedFileConnection',
    url: 'String', createdAt: 'String', updatedAt: 'String', closedAt: 'String', mergedAt: 'String',
    author: 'User', repository: 'Repository', additions: 'Int', deletions: 'Int', changedFiles: 'Int',
  },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  LabelConnection: { nodes: '[Label]' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  IssueCommentConnection: { nodes: '[IssueComment]', totalCount: 'Int' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', comment: 'IssueComment', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', description: 'String' },
  __Field: { name: 'String', description: 'String', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String' },
  Node: { id: 'ID' },
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'repository', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'LABEL', 'MILESTONE'];

// --------------------------------------------------------------------------------------------
// execution
// --------------------------------------------------------------------------------------------

interface ExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> | string | number | boolean | null;

interface TypedObject {
  __typename: string;
  __repo?: Repo;
  __issue?: Issue;
  __pull?: PullRequest;
  __comment?: { id: number; body: string };
  [key: string]: unknown;
}

function argValue(selection: Selection, name: string, ctx: ExecContext): unknown {
  const arg = selection.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(repo: Repo, issue: Issue): TypedObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pull: PullRequest): TypedObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function repoObject(repo: Repo): TypedObject {
  return { __typename: 'Repository', __repo: repo };
}

function resolveIssueConnection(repo: Repo, selection: Selection, ctx: ExecContext): Record<string, unknown> {
  const first = argValue(selection, 'first', ctx);
  const after = argValue(selection, 'after', ctx);
  const states = argValue(selection, 'states', ctx);
  const orderBy = argValue(selection, 'orderBy', ctx);
  let list = [...repo.issues.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>).direction;
    if (typeof dir === 'string') direction = dir.toUpperCase();
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const afterNumber = numberFromCursor(after);
  if (afterNumber !== null) {
    const index = list.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) list = list.slice(index + 1);
  }
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return {
    nodes: page.map((issue) => issueObject(repo, issue)),
    totalCount: list.length,
    pageInfo: { hasNextPage, hasPreviousPage: false, endCursor, startCursor: page.length > 0 ? cursorFor(page[0]?.number ?? 0) : null },
  };
}

function resolvePullConnection(repo: Repo, selection: Selection, ctx: ExecContext): Record<string, unknown> {
  const first = argValue(selection, 'first', ctx);
  let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
  list.sort((a, b) => b.number - a.number);
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  return {
    nodes: page.map((pull) => pullObject(repo, pull)),
    totalCount: list.length,
    pageInfo: { hasNextPage: list.length > page.length, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

/** Resolve one field of a typed object; returns null for a null value. */
function resolveField(parentType: string, parent: TypedObject | Record<string, unknown>, selection: Selection, ctx: ExecContext): GqlValue {
  const name = selection.name;
  // Query root.
  if (parentType === 'Query') {
    if (name === 'viewer') return { __typename: 'User', login: VIEWER.login, id: globalId('U', VIEWER.id) };
    if (name === 'repository') {
      const owner = argValue(selection, 'owner', ctx);
      const repoName = argValue(selection, 'name', ctx);
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
      const repo = store.getRepo(owner, repoName);
      return repo ? repoObject(repo) : null;
    }
    if (name === 'node') {
      const id = argValue(selection, 'id', ctx);
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'R') {
        const repoId = Number(decoded.parts[0]);
        for (const repo of store.listRepos(VIEWER.login)) {
          if (repo.id === repoId) return repoObject(repo);
        }
        return null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = argValue(selection, 'name', ctx);
      if (typeof typeName !== 'string') return null;
      if (typeName === 'SearchType') {
        return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((v) => ({ name: v })) };
      }
      const fields = INTROSPECTION_FIELDS[typeName];
      if (!fields) return null;
      return { __typename: '__Type', name: typeName, kind: 'OBJECT', fields: fields.map((f) => ({ name: f })), enumValues: null };
    }
    return null;
  }
  // Mutation root.
  if (parentType === 'Mutation') {
    const input = argValue(selection, 'input', ctx);
    const inputObj = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repoId = decodeGlobalId(String(inputObj.repositoryId ?? ''));
      const repo = repoId?.kind === 'R' ? [...store.listRepos(VIEWER.login)].find((r) => r.id === Number(repoId.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const stamp = nextTimestamp();
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.nextIssueNumber++,
        title: typeof inputObj.title === 'string' ? inputObj.title : '',
        body: typeof inputObj.body === 'string' ? inputObj.body : '',
        state: 'open',
        labels: [],
        user: VIEWER.login,
        createdAt: stamp.iso,
        updatedAt: stamp.iso,
        seq: stamp.ms,
      };
      repo.issues.set(issue.number, issue);
      return { issue: issueObject(repo, issue) };
    }
    if (name === 'closeIssue') {
      const decoded = decodeGlobalId(String(inputObj.issueId ?? ''));
      if (decoded?.kind !== 'I') {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      const repo = [...store.listRepos(VIEWER.login)].find((r) => r.id === repoId);
      const issue = repo?.issues.get(number);
      if (!repo || !issue) {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      issue.state = 'closed';
      issue.updatedAt = nextTimestamp().iso;
      return { issue: issueObject(repo, issue) };
    }
    if (name === 'createPullRequest') {
      const repoId = decodeGlobalId(String(inputObj.repositoryId ?? ''));
      const repo = repoId?.kind === 'R' ? [...store.listRepos(VIEWER.login)].find((r) => r.id === Number(repoId.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const head = typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '';
      const base = typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      const stamp = nextTimestamp();
      const pull: PullRequest = {
        id: repo.nextPullId++,
        number: repo.nextPullNumber++,
        title: typeof inputObj.title === 'string' ? inputObj.title : '',
        body: typeof inputObj.body === 'string' ? inputObj.body : '',
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
      return { pullRequest: pullObject(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(inputObj.pullRequestId ?? ''));
      if (decoded?.kind !== 'P') {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      const repo = [...store.listRepos(VIEWER.login)].find((r) => r.id === repoId);
      const pull = repo?.pulls.get(number);
      if (!repo || !pull) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      if (pull.state !== 'open') {
        ctx.errors.push({ message: 'mergePullRequest: pull request is not open' });
        return null;
      }
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (!baseTip || !headTip || planMerge(repo, baseTip, headTip).conflict) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      const mergeSha = squashMerge(repo, pull);
      if (mergeSha === null) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      const stamp = nextTimestamp();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = stamp.iso;
      pull.updatedAt = stamp.iso;
      return { pullRequest: pullObject(repo, pull) };
    }
    if (name === 'addComment') {
      const decoded = decodeGlobalId(String(inputObj.subjectId ?? ''));
      if (decoded?.kind !== 'I') {
        ctx.errors.push({ message: 'addComment: subject not found' });
        return null;
      }
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      const repo = [...store.listRepos(VIEWER.login)].find((r) => r.id === repoId);
      const issue = repo?.issues.get(number);
      if (!repo || !issue) {
        ctx.errors.push({ message: 'addComment: issue not found' });
        return null;
      }
      const body = typeof inputObj.body === 'string' ? inputObj.body : '';
      const stamp = nextTimestamp();
      const comment = {
        id: repo.nextCommentId++,
        issueNumber: number,
        body,
        user: VIEWER.login,
        createdAt: stamp.iso,
        updatedAt: stamp.iso,
      };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return {
        commentEdge: {
          node: { __typename: 'IssueComment', __comment: { id: comment.id, body }, id: globalId('C', repo.id, number, comment.id), body },
          cursor: cursorFor(comment.id),
        },
      };
    }
    return null;
  }
  // Typed object fields.
  const obj = parent as TypedObject;
  const repo = obj.__repo;
  // Node interface: `id` comes from the runtime object.
  if (parentType === 'Node') {
    if (name === 'id') {
      if (obj.__typename === 'Repository' && repo) return globalId('R', repo.id);
      if (obj.__typename === 'Issue' && repo && obj.__issue) return globalId('I', repo.id, obj.__issue.number);
      if (obj.__typename === 'PullRequest' && repo && obj.__pull) return globalId('P', repo.id, obj.__pull.number);
      return null;
    }
    return null;
  }
  switch (parentType) {
    case 'User':
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return globalId('U', VIEWER.id);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      return null;
    case 'Repository': {
      if (!repo) return null;
      if (name === 'id') return globalId('R', repo.id);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner, id: globalId('U', VIEWER.id) };
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { name: repo.defaultBranch } : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
      if (name === 'createdAt') return repo.createdAt;
      if (name === 'updatedAt') return repo.updatedAt;
      if (name === 'isPrivate') return repo.private;
      if (name === 'issue') {
        const number = argValue(selection, 'number', ctx);
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        return issue ? issueObject(repo, issue) : null;
      }
      if (name === 'issues') return resolveIssueConnection(repo, selection, ctx);
      if (name === 'pullRequests') return resolvePullConnection(repo, selection, ctx);
      if (name === 'pullRequest') {
        const number = argValue(selection, 'number', ctx);
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        return pull ? pullObject(repo, pull) : null;
      }
      return null;
    }
    case 'Ref':
      if (name === 'name') return (parent as Record<string, unknown>).name ?? null;
      return null;
    case 'Issue': {
      const issue = obj.__issue;
      if (!issue || !repo) return null;
      if (name === 'id') return globalId('I', repo.id, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issueState(issue);
      if (name === 'body') return issue.body;
      if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'closedAt') return issue.state === 'closed' ? issue.updatedAt : null;
      if (name === 'author') return { __typename: 'User', login: issue.user, id: globalId('U', VIEWER.id) };
      if (name === 'labels') return { nodes: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })) };
      if (name === 'comments') {
        const comments = repo.comments.get(issue.number) ?? [];
        return { nodes: comments.map((c) => ({ __typename: 'IssueComment', id: globalId('C', repo.id, issue.number, c.id), body: c.body })), totalCount: comments.length };
      }
      if (name === 'repository') return repoObject(repo);
      return null;
    }
    case 'IssueConnection': {
      const conn = parent as unknown as Record<string, unknown>;
      if (name === 'nodes') return (conn.nodes as TypedObject[]) ?? [];
      if (name === 'edges') return ((conn.nodes as TypedObject[]) ?? []).map((node) => ({ node, cursor: cursorFor((node.__issue?.number ?? 0)) }));
      if (name === 'pageInfo') return (conn.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null };
      if (name === 'totalCount') return (conn.totalCount as number) ?? 0;
      return null;
    }
    case 'IssueEdge': {
      const edge = parent as unknown as Record<string, unknown>;
      if (name === 'node') return (edge.node as TypedObject) ?? null;
      if (name === 'cursor') return (edge.cursor as string) ?? null;
      return null;
    }
    case 'PageInfo': {
      const info = parent as unknown as Record<string, unknown>;
      if (name === 'hasNextPage') return (info.hasNextPage as boolean) ?? false;
      if (name === 'hasPreviousPage') return (info.hasPreviousPage as boolean) ?? false;
      if (name === 'endCursor') return (info.endCursor as string | null) ?? null;
      if (name === 'startCursor') return (info.startCursor as string | null) ?? null;
      return null;
    }
    case 'PullRequest': {
      const pull = obj.__pull;
      if (!pull || !repo) return null;
      if (name === 'id') return globalId('P', repo.id, pull.number);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return prMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (name === 'headRefName') return pull.head;
      if (name === 'baseRefName') return pull.base;
      if (name === 'headRefOid') return pull.headSha;
      if (name === 'baseRefOid') return pull.baseSha;
      if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (name === 'createdAt') return pull.createdAt;
      if (name === 'updatedAt') return pull.updatedAt;
      if (name === 'closedAt') return pull.state === 'closed' ? pull.updatedAt : null;
      if (name === 'mergedAt') return pull.mergedAt;
      if (name === 'author') return { __typename: 'User', login: repo.owner, id: globalId('U', VIEWER.id) };
      if (name === 'repository') return repoObject(repo);
      if (name === 'additions' || name === 'deletions' || name === 'changedFiles') {
        const files = pullFiles(repo, pull);
        if (name === 'additions') return files.reduce((s, f) => s + f.additions, 0);
        if (name === 'deletions') return files.reduce((s, f) => s + f.deletions, 0);
        return files.length;
      }
      if (name === 'files') {
        const first = argValue(selection, 'first', ctx);
        const files = pullFiles(repo, pull);
        const limit = typeof first === 'number' ? first : files.length;
        const page = files.slice(0, limit);
        return {
          nodes: page.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
          totalCount: files.length,
          pageInfo: { hasNextPage: files.length > page.length, hasPreviousPage: false, endCursor: null, startCursor: null },
        };
      }
      return null;
    }
    case 'PullRequestConnection': {
      const conn = parent as unknown as Record<string, unknown>;
      if (name === 'nodes') return (conn.nodes as TypedObject[]) ?? [];
      if (name === 'edges') return ((conn.nodes as TypedObject[]) ?? []).map((node) => ({ node, cursor: cursorFor(node.__pull?.number ?? 0) }));
      if (name === 'pageInfo') return (conn.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null };
      if (name === 'totalCount') return (conn.totalCount as number) ?? 0;
      return null;
    }
    case 'PullRequestEdge': {
      const edge = parent as unknown as Record<string, unknown>;
      if (name === 'node') return (edge.node as TypedObject) ?? null;
      if (name === 'cursor') return (edge.cursor as string) ?? null;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = parent as unknown as Record<string, unknown>;
      if (name === 'nodes') return (conn.nodes as Array<Record<string, unknown>>) ?? [];
      if (name === 'pageInfo') return (conn.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null };
      if (name === 'totalCount') return (conn.totalCount as number) ?? 0;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = parent as unknown as Record<string, unknown>;
      if (name === 'path') return (file.path as string) ?? null;
      if (name === 'additions') return (file.additions as number) ?? 0;
      if (name === 'deletions') return (file.deletions as number) ?? 0;
      if (name === 'changeType') return (file.changeType as string) ?? null;
      return null;
    }
    case 'Label': {
      const label = parent as unknown as Record<string, unknown>;
      if (name === 'name') return (label.name as string) ?? null;
      if (name === 'color') return (label.color as string) ?? null;
      if (name === 'description') return (label.description as string) ?? null;
      if (name === 'id') return globalId('L', String(label.name ?? ''));
      return null;
    }
    case 'IssueCommentConnection': {
      const conn = parent as unknown as Record<string, unknown>;
      if (name === 'nodes') return (conn.nodes as TypedObject[]) ?? [];
      if (name === 'totalCount') return (conn.totalCount as number) ?? 0;
      return null;
    }
    case 'IssueComment': {
      const comment = parent as unknown as Record<string, unknown>;
      if (name === 'id') return (comment.id as string) ?? null;
      if (name === 'body') return (comment.body as string) ?? null;
      if (name === 'author') return { __typename: 'User', login: VIEWER.login, id: globalId('U', VIEWER.id) };
      return null;
    }
    case 'IssueCommentEdge': {
      const edge = parent as unknown as Record<string, unknown>;
      if (name === 'node') return (edge.node as TypedObject) ?? null;
      if (name === 'cursor') return (edge.cursor as string) ?? null;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = parent as unknown as Record<string, unknown>;
      if (name === 'issue') return (payload.issue as TypedObject) ?? null;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = parent as unknown as Record<string, unknown>;
      if (name === 'pullRequest') return (payload.pullRequest as TypedObject) ?? null;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      const payload = parent as unknown as Record<string, unknown>;
      if (name === 'commentEdge') return (payload.commentEdge as Record<string, unknown>) ?? null;
      if (name === 'comment') {
        const edge = payload.commentEdge as Record<string, unknown> | undefined;
        return (edge?.node as TypedObject) ?? null;
      }
      if (name === 'clientMutationId') return null;
      return null;
    }
    case '__Type': {
      const type = parent as unknown as Record<string, unknown>;
      if (name === 'name') return (type.name as string) ?? null;
      if (name === 'kind') return (type.kind as string) ?? null;
      if (name === 'description') return null;
      if (name === 'fields') return (type.fields as Array<Record<string, unknown>>) ?? null;
      if (name === 'enumValues') return (type.enumValues as Array<Record<string, unknown>>) ?? null;
      return null;
    }
    case '__Field': {
      const field = parent as unknown as Record<string, unknown>;
      if (name === 'name') return (field.name as string) ?? null;
      if (name === 'description') return null;
      if (name === 'type') return { name: 'String' };
      return null;
    }
    case '__EnumValue': {
      const value = parent as unknown as Record<string, unknown>;
      if (name === 'name') return (value.name as string) ?? null;
      if (name === 'description') return null;
      return null;
    }
    default:
      return null;
  }
}

/** Execute one selection set against a parent object of a known type. */
function executeSelections(parentType: string, parent: TypedObject | Record<string, unknown>, selections: Selection[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[parentType] ?? {};
  // Inline fragments (`... on Repository`) match the runtime type, not the static one
  // (e.g. a `node` field typed Node that is actually a Repository).
  const runtimeType = (parent as TypedObject).__typename ?? parentType;
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      if (selection.fragmentType !== runtimeType) continue;
      const nested = executeSelections(runtimeType, parent, selection.selections ?? [], ctx);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const returnType = fields[selection.name];
    if (returnType === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const value = resolveField(parentType, parent, selection, ctx);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections === null) {
      out[key] = value;
      continue;
    }
    const childType = returnType.replace(/[\[\]!]/g, '');
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object') return executeSelections(childType, item as TypedObject, selection.selections as Selection[], ctx);
        return item;
      });
    } else if (typeof value === 'object') {
      out[key] = executeSelections(childType, value as TypedObject, selection.selections as Selection[], ctx);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const ctx: ExecContext = { variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: TypedObject = { __typename: rootType };
  const data = executeSelections(rootType, root, operation.selections, ctx);
  return { data, errors: ctx.errors };
}

/**
 * Execute a GraphQL request body: a single `{query, variables}` object or an array of them
 * (batched operations answer in order). Returns the response body object.
 */
export function executeGraphQL(body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
    }
    const query = (entry as Record<string, unknown>).query;
    const variables = (entry as Record<string, unknown>).variables;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'Request must include a query string.' }] };
    }
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query.' }] };
    }
    if (operations.length === 0) {
      return { errors: [{ message: 'The document holds no operation.' }] };
    }
    const vars = variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
    const results = operations.map((operation) => executeOperation(operation, vars));
    // A document with several operations answers the first; the suite batches via arrays.
    const first = results[0] as { data: Record<string, unknown>; errors: Array<{ message: string }> };
    const response: Record<string, unknown> = { data: first.data };
    if (first.errors.length > 0) response.errors = first.errors;
    return response;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
