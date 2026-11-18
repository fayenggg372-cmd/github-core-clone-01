// The HTTP server: one process serving git smart HTTP, REST v3, GraphQL and MCP from the
// same in-memory store. Routing:
//
//   GET  /healthz                                            200 {ok:true}, no auth
//   GET  /{owner}/{repo}.git/info/refs?service=...           git advertisement (Bearer)
//   POST /{owner}/{repo}.git/git-upload-pack                 (Bearer)
//   POST /{owner}/{repo}.git/git-receive-pack                (Bearer)
//   *    /api/v3/*                                           REST v3 (Bearer)
//   POST /api/graphql                                        GraphQL (Bearer)
//   POST /mcp                                                MCP Streamable HTTP (Bearer)
//   DELETE /mcp                                              session close, 204
//   *    everything else                                     404 {message:'Not Found'}
//
// Auth: MAKEFUN_SHOP_TOKEN (shpat_...) must arrive as `Authorization: Bearer <token>`;
// missing or wrong token is 401 {message}. When the variable is unset (local development
// only) auth is not enforced. Request ids are a deterministic counter, never random, so a
// replay of the same request stream stays identical.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPackV0, uploadPackV2, type GitService } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';
import { handleRest, type HttpCtx } from './rest.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}

function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const token = bearerToken(req);
  return token !== null && token === EXPECTED_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on('error', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
  });
}

function decodeSegments(pathname: string): string[] {
  // Fast path: most suite paths carry no escapes, so skip decodeURIComponent entirely
  // when a segment has no '%'. A single pass replaces split/filter/map.
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= pathname.length; i += 1) {
    if (i === pathname.length || pathname[i] === '/') {
      if (i > start) {
        const segment = pathname.slice(start, i);
        if (segment.indexOf('%') < 0) out.push(segment);
        else {
          try {
            out.push(decodeURIComponent(segment));
          } catch {
            out.push(segment);
          }
        }
      }
      start = i + 1;
    }
  }
  return out;
}

export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        // Parse the request line by hand: `new URL` costs more than the whole route
        // lookup on the hot paths, and the query string is only needed by info/refs and
        // the REST handlers, so it is parsed lazily.
        const rawUrl = req.url ?? '/';
        const queryAt = rawUrl.indexOf('?');
        const pathname = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
        const method = req.method ?? 'GET';
        const segments = decodeSegments(pathname);
        const requestId = nextRequestId();
        let searchParams: URLSearchParams | null = null;
        const query = (): URLSearchParams => {
          if (searchParams === null) {
            searchParams = new URLSearchParams(queryAt < 0 ? '' : rawUrl.slice(queryAt + 1));
          }
          return searchParams;
        };

        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs and .../git-upload-pack|git-receive-pack.
        if (segments.length >= 2 && segments[1]?.endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const tail = segments.slice(2).join('/');
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (method === 'GET' && tail === 'info/refs') {
            const service = query().get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Missing service parameter' });
              return;
            }
            const wantV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
            const answer = infoRefs(owner, repoName, service as GitService, wantV2);
            res.writeHead(answer.status, { 'content-type': answer.contentType });
            res.end(answer.body);
            return;
          }
          if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
            const { body, tooLarge } = await readBody(req);
            if (tooLarge) {
              sendJson(res, 413, { message: 'Request body too large' });
              return;
            }
            const answer = tail === 'git-upload-pack'
              ? req.headers['git-protocol'] === 'version=2'
                ? uploadPackV2(owner, repoName, body)
                : uploadPackV0(owner, repoName, body)
              : receivePack(owner, repoName, body);
            res.writeHead(answer.status, { 'content-type': answer.contentType });
            res.end(answer.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
            return;
          }
          // GETs never carry a body the handlers read (they use path + query only), so
          // when the headers promise no body bytes, skip the body read entirely: reading
          // an empty body would produce exactly the same context.
          const noBody = method === 'GET'
            && (req.headers['content-length'] === undefined || req.headers['content-length'] === '0')
            && req.headers['transfer-encoding'] === undefined;
          const { body, tooLarge } = noBody
            ? { body: Buffer.alloc(0), tooLarge: false }
            : await readBody(req);
          if (tooLarge) {
            sendJson(res, 413, { message: 'Request body too large' }, { 'x-github-request-id': requestId });
            return;
          }
          const bodyText = body.toString('utf8');
          let parsed: unknown;
          let bodyMalformed = false;
          if (bodyText.trim() === '') {
            parsed = undefined;
          } else {
            try {
              parsed = JSON.parse(bodyText);
            } catch {
              parsed = null;
              bodyMalformed = true;
            }
          }
          const ctx: HttpCtx = {
            method,
            segments: segments.slice(2),
            query: query(),
            bodyText,
            body: parsed,
            bodyMalformed,
            host: req.headers.host ?? 'localhost',
            requestId,
            send: (status, responseBody, extraHeaders = {}) => {
              sendJson(res, status, responseBody, { 'x-github-request-id': requestId, ...extraHeaders });
            },
            sendText: (status, text, extraHeaders = {}) => {
              res.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': requestId, ...extraHeaders });
              res.end(text);
            },
            sendNoBody: (status, extraHeaders = {}) => {
              res.writeHead(status, { 'x-github-request-id': requestId, ...extraHeaders });
              res.end();
            },
          };
          const handled = handleRest(ctx);
          if (!handled) sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
          return;
        }

        // GraphQL.
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, 413, { errors: [{ message: 'Request body too large' }] });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
            return;
          }
          const result = executeGraphQL(parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP.
        if (segments[0] === 'mcp' && segments.length === 1) {
          if (method === 'DELETE') {
            if (!authorized(req)) {
              sendJson(res, 401, { message: 'Requires authentication' });
              return;
            }
            res.writeHead(204);
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body too large' } });
            return;
          }
          const protocolVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null;
          const result = handleMcpBody(body.toString('utf8'), protocolVersion);
          if (result.status === 202) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let a malformed request kill the process: the suite's protocol checks send
        // garbage on purpose and expect the server to stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do.
          }
        }
      }
    })();
  });
}
