/**
 * Tests that drive the server through a real MCP Client -- no port, no socket,
 * no mock transport.
 *
 * `createMcpHandler(...).fetch` is a plain `(Request) => Promise<Response>`, so
 * handing it to the client transport's `fetch` option serves every request
 * in-process through the exact code path `http.ts` deploys. Nothing ever dials
 * http://test.local.
 *
 * The HN API is stubbed, so these run offline and deterministically.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpHttpHandler, ProtocolErrorCode } from '@modelcontextprotocol/server';

import type { HnApi, HnItem, HnStory } from '../src/hn.ts';
import { createServer } from '../src/server.ts';

const DROPBOX: HnItem = {
    id: 8863,
    type: 'story',
    by: 'dhouston',
    title: 'My YC app: Dropbox - Throw away your USB drive',
    url: 'http://www.getdropbox.com/u/2/screencast.html',
    score: 104,
    time: 1175714200,
    descendants: 71,
    kids: [9224]
};

const COMMENT: HnItem = { id: 9224, type: 'comment', by: 'brujo', text: 'Looks <i>useful</i>.' };

const HIT: HnStory = {
    id: 8863,
    title: 'My YC app: Dropbox - Throw away your USB drive',
    url: 'http://www.getdropbox.com/u/2/screencast.html',
    author: 'dhouston',
    points: 104,
    comments: 71,
    createdAt: '2007-04-04T19:16:40.000Z'
};

/** A stub standing in for the live API; `createServer` takes it by injection. */
const stubApi: HnApi = {
    getItem: async id => (id === 8863 ? DROPBOX : id === 9224 ? COMMENT : null),
    getTopStoryIds: async () => [8863],
    getTopStories: async limit => [DROPBOX].slice(0, limit),
    searchStories: async (query, limit) => (query === 'dropbox' ? [HIT].slice(0, limit) : [])
};

let handler: McpHttpHandler;
let client: Client;

beforeEach(async () => {
    handler = createMcpHandler(() => createServer(stubApi));
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
    });
    client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
});

afterEach(async () => {
    // Client first, then the handler: close() aborts anything still in flight
    // so a hung call can't leak into the next test.
    await client.close();
    await handler.close();
});

describe('tools', () => {
    it('advertises every tool with the JSON Schema derived from its Zod schema', async () => {
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name).sort();
        assert.deepEqual(names, ['get_story', 'get_top_stories', 'search_stories']);

        // The one Zod schema became the schema the model sees...
        const search = tools.find(t => t.name === 'search_stories');
        assert.ok(search);
        assert.equal(search.inputSchema.type, 'object');
        assert.deepEqual(search.inputSchema.required, ['query']);
        // ...including the .describe() text, the only docs the model gets.
        const props = search.inputSchema.properties as Record<string, { description?: string }>;
        assert.match(props.query.description ?? '', /Words to search/);
        // outputSchema is advertised too, so clients can validate results.
        assert.ok(search.outputSchema);
    });

    it('returns structuredContent alongside the human-readable text', async () => {
        const result = await client.callTool({ name: 'search_stories', arguments: { query: 'dropbox' } });
        assert.deepEqual(result.structuredContent, { stories: [HIT] });
        assert.match((result.content as { text: string }[])[0].text, /Dropbox/);
        assert.notEqual(result.isError, true);
    });

    it('rejects arguments the input schema refuses, before the handler runs', async () => {
        const rejected = await client.callTool({ name: 'search_stories', arguments: { query: 'dropbox', limit: 999 } });
        // Not a thrown error -- an ordinary result the model reads and retries.
        assert.equal(rejected.isError, true);
        assert.match((rejected.content as { text: string }[])[0].text, /<=50/);
    });

    it('reports a missing story as a tool error carrying a recovery hint', async () => {
        const missing = await client.callTool({ name: 'get_story', arguments: { id: 999999999 } });
        assert.equal(missing.isError, true);
        const text = (missing.content as { text: string }[])[0].text;
        assert.match(text, /No Hacker News item with id 999999999/);
        assert.match(text, /search_stories/); // tells the model where valid ids come from
    });

    it('applies schema defaults the caller omitted', async () => {
        const result = await client.callTool({ name: 'get_top_stories', arguments: {} });
        assert.notEqual(result.isError, true);
        assert.match((result.content as { text: string }[])[0].text, /Dropbox/);
    });
});

describe('resources', () => {
    /** Resource contents are a text|blob union, so narrow before reading. */
    const textOf = (entry: { text: string } | { blob: string }): string => {
        assert.ok('text' in entry, 'expected a text resource, got a blob');
        return entry.text;
    };

    it('serves a static resource at its fixed URI', async () => {
        const { contents } = await client.readResource({ uri: 'hn://top' });
        assert.equal(contents[0].uri, 'hn://top');
        assert.equal(contents[0].mimeType, 'application/json');
        assert.equal(JSON.parse(textOf(contents[0]))[0].id, 8863);
    });

    it('parses template variables out of the URI', async () => {
        const { contents } = await client.readResource({ uri: 'hn://item/8863' });
        assert.equal(contents[0].uri, 'hn://item/8863');
        assert.equal(JSON.parse(textOf(contents[0])).by, 'dhouston');
    });

    it('fails a read of a template instance that does not exist', async () => {
        // Resources have no isError channel -- this rejects.
        await assert.rejects(() => client.readResource({ uri: 'hn://item/999999999' }));
    });
});

describe('prompts', () => {
    it('fills the template with the fetched story and its comments', async () => {
        const { messages } = await client.getPrompt({ name: 'discuss_story', arguments: { id: '8863' } });
        assert.equal(messages[0].role, 'user');
        const text = (messages[0].content as { text: string }).text;
        assert.match(text, /Dropbox/);
        assert.match(text, /Looks  useful/); // HTML tags stripped
    });

    it('fails a missing argument as a protocol error, not an isError result', async () => {
        // THE CONTRAST: a bad tool argument came back as isError: true above.
        // A bad prompt argument is JSON-RPC -32602, which the model never sees.
        await assert.rejects(
            () => client.getPrompt({ name: 'discuss_story', arguments: {} }),
            (error: { code?: number }) => {
                assert.equal(error.code, ProtocolErrorCode.InvalidParams);
                assert.equal(error.code, -32602);
                return true;
            }
        );
    });
});
