# hn-mcp

A Hacker News MCP server, built to learn the Model Context Protocol. It wraps the
public HN APIs — no key, no OAuth, no rate limits — so the interesting part is the
protocol, not the auth plumbing.

Built on **MCP TypeScript SDK v2** (`@modelcontextprotocol/server` 2.4.0). Note that
most MCP tutorials and example repos online are v1 (`@modelcontextprotocol/sdk`),
whose API differs: `server.tool()` → `registerTool()`, `new StdioServerTransport()` +
`connect()` → `serveStdio()`, per-request HTTP transport wiring → `createMcpHandler()`.

## What it exposes

| Primitive | Name | Teaches |
|---|---|---|
| Tool | `search_stories` | Zod input schema → the JSON Schema the model sees; `outputSchema` + `structuredContent` |
| Tool | `get_top_stories` | all-optional arguments, schema defaults |
| Tool | `get_story` | tool errors: `isError: true` with a recovery hint the model reads |
| Resource | `hn://top` | a static resource at a fixed URI |
| Resource | `hn://item/{id}` | `ResourceTemplate`, parsed URI variables, `ResourceNotFoundError` |
| Prompt | `discuss_story` | prompts fail as protocol error `-32602`, a different channel from tools |

The three primitives differ by **who decides to use them**: tools are model-controlled,
resources are application-controlled (the client picks what to attach), prompts are
user-controlled. Mixing those up is the usual server-design mistake.

## Layout

```
src/hn.ts       the HN API client — no MCP in this file
src/server.ts   createServer(): every tool, resource and prompt
src/stdio.ts    stdio entry (how a local host runs it)
src/http.ts     Streamable HTTP entry (one endpoint, many clients)
test/           drives a real Client against the handler, in-process, offline
```

`createServer` is a **factory**, not a singleton, and takes the HN API by injection —
the HTTP handler calls it once per request, and the tests pass a stub.

## Commands

```sh
npm test         # 10 tests, no network
npm run typecheck
npm run dev      # stdio
npm run http     # http://127.0.0.1:3000/mcp
npm run inspect  # MCP Inspector — the fastest way to poke at a server
```

## Register it in a host

```sh
claude mcp add hn -- npx tsx src/stdio.ts   # Claude Code; then /mcp in a session
```

VS Code wants `.vscode/mcp.json` with `{"servers":{"hn":{"type":"stdio","command":"npx","args":["tsx","src/index.ts"]}}}`;
Cursor wants the same under `mcpServers` in `.cursor/mcp.json`.

## Two things that will bite you

**stdout is the protocol channel.** One `console.log` anywhere in the import graph puts
a non-JSON line ahead of the `initialize` response and the host silently drops the
connection. Log with `console.error`. Try it: append a `console.log` to `src/server.ts`,
run `npm run inspect`, watch it fail.

**The HTTP handler trusts its caller.** It validates no `Host` header, no `Origin`, and
verifies no token — those guards go in front of it (see `src/http.ts`). The `Host` check
is what stops DNS rebinding: a malicious page resolving its own domain to `127.0.0.1` so
the browser treats your local server as same-origin and drives your tools.

## Deliberately not here

OAuth, sessions/resumability, notifications & subscriptions, elicitation, sampling,
skills, and the Express/Fastify/Hono mounts. The SDK docs have a page for each:
<https://ts.sdk.modelcontextprotocol.io/v2/>
