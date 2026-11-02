/**
 * Streamable HTTP entry point -- the same `createServer` factory, different
 * transport. Use this shape when one endpoint serves many clients, rather than
 * a host spawning a process per session.
 *
 * `createMcpHandler(factory)` returns `{ fetch, close, notify, bus }`, where
 * `fetch` is a web-standard `(Request) => Promise<Response>`. In SDK v1 this
 * was per-request `StreamableHTTPServerTransport` wiring plus `connect()`.
 *
 * Three things worth understanding here:
 *
 * 1. The factory runs ONCE PER REQUEST. Each request gets a fresh McpServer and
 *    nothing is held between them, so this endpoint is stateless and scales
 *    horizontally as-is.
 *
 * 2. The handler trusts its caller completely: it validates no Host header, no
 *    Origin, and verifies no token. Those checks go IN FRONT of it. The Host
 *    check is what stops DNS rebinding -- a malicious web page resolving its
 *    own domain to 127.0.0.1 so the browser treats this local server as
 *    same-origin and lets the page drive your tools. Under Express/Fastify/Hono
 *    the SDK's app factories arm both guards by default; on bare node:http you
 *    compose them yourself, as below.
 *
 * 3. The reply is a single JSON body, upgrading to SSE only if a handler emits
 *    a notification (progress, logging) before its result. Pass
 *    `{ responseMode: 'json' | 'sse' }` to pin one shape.
 */

import { createServer as createHttpServer } from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';

import { createServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);

const handler = createMcpHandler(() => createServer());
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createHttpServer((req, res) => {
    // Both guards answer with 403 themselves and return false; bail out before
    // the MCP handler ever sees the request.
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
});

httpServer.listen(PORT, '127.0.0.1', () => {
    console.error(`hn-mcp listening on http://127.0.0.1:${PORT}/mcp`);
});

process.on('SIGINT', () => {
    void (async () => {
        await handler.close();
        httpServer.close();
        process.exit(0);
    })();
});
