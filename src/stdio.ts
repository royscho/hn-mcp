/**
 * stdio entry point.
 *
 * This is how a local host (Claude Code, VS Code, Cursor) runs an MCP server:
 * it spawns this process as a child and talks JSON-RPC over its stdin/stdout.
 *
 * `serveStdio(factory)` owns the transport. In SDK v1 this was
 * `new StdioServerTransport()` followed by `server.connect(transport)`.
 *
 * THE RULE THAT WILL BITE YOU: stdout is the protocol channel. The host parses
 * every line of it as JSON-RPC, so a single `console.log` anywhere in the
 * import graph corrupts the stream and the connection dies -- usually with no
 * useful error. All logging goes to stderr via `console.error`.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';

const handle = serveStdio(() => createServer());

console.error('hn-mcp running on stdio');

process.on('SIGINT', () => {
    void handle.close();
});
