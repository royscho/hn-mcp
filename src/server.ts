/**
 * The MCP surface: every tool, resource and prompt this server exposes.
 *
 * MCP has three primitives, and the difference between them is about *who
 * decides to use them*:
 *
 *   - TOOLS are model-controlled. The model reads their names, descriptions
 *     and schemas and decides on its own to call one.
 *   - RESOURCES are application-controlled. The client (the host app) decides
 *     what to read and attach as context; the model does not call them.
 *   - PROMPTS are user-controlled. A person picks one from a menu or a slash
 *     command.
 *
 * Getting that distinction wrong is the most common mistake in server design:
 * read-only lookups the model should choose to make are tools, not resources.
 */

import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { type HnApi, type HnItem, liveHnApi } from './hn.js';

/** Render one item as the plain text a model reads. */
function describeItem(item: HnItem): string {
    const lines = [
        `${item.title ?? '(untitled)'} (id ${item.id})`,
        `by ${item.by ?? 'unknown'} | ${item.score ?? 0} points | ${item.descendants ?? 0} comments`
    ];
    if (item.url) lines.push(item.url);
    if (item.text) lines.push('', item.text);
    return lines.join('\n');
}

const storyShape = z.object({
    id: z.number().describe('The HN item id, usable with get_story'),
    title: z.string(),
    url: z.string().nullable().describe('The story link, or null for an Ask HN / text post'),
    author: z.string(),
    points: z.number(),
    comments: z.number(),
    createdAt: z.string()
});

/**
 * Builds a fresh server instance.
 *
 * This is a FACTORY, not a singleton, and that matters: the HTTP handler in
 * `http.ts` calls it once per request. Registering tools on a shared instance
 * created outside a factory is the bug that makes an HTTP server leak state
 * between callers.
 *
 * `api` is injected so tests can pass a stub and run with no network.
 */
export function createServer(api: HnApi = liveHnApi): McpServer {
    const server = new McpServer({ name: 'hn-mcp', version: '1.0.0' });

    // ---------------------------------------------------------------- tools

    /**
     * Note `.describe()` on every field. It survives the conversion to JSON
     * Schema, and that description is the *only* documentation the model gets
     * for an argument. A field without one is a field the model will guess at.
     *
     * `outputSchema` adds a second, machine-readable rendering of the result:
     * the SDK validates `structuredContent` against it before the result
     * leaves the server, and advertises its JSON Schema in `tools/list` so the
     * client can validate too.
     */
    server.registerTool(
        'search_stories',
        {
            title: 'Search Hacker News',
            description: 'Search Hacker News stories by keyword, newest and highest-ranked first',
            inputSchema: z.object({
                query: z.string().min(1).describe('Words to search story titles and URLs for'),
                limit: z.number().int().min(1).max(50).default(10).describe('How many stories to return (1-50)')
            }),
            outputSchema: z.object({ stories: z.array(storyShape) }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async ({ query, limit }) => {
            const stories = await api.searchStories(query, limit);
            if (stories.length === 0) {
                return { content: [{ type: 'text', text: `No stories matched "${query}".` }], structuredContent: { stories } };
            }
            const text = stories
                .map(s => `${s.title} (id ${s.id}) — ${s.points} points, ${s.comments} comments${s.url ? `\n  ${s.url}` : ''}`)
                .join('\n');
            return { content: [{ type: 'text', text }], structuredContent: { stories } };
        }
    );

    /** A tool whose only argument is optional: the model can call it with `{}`. */
    server.registerTool(
        'get_top_stories',
        {
            title: 'Hacker News front page',
            description: 'Get the stories currently on the Hacker News front page',
            inputSchema: z.object({
                limit: z.number().int().min(1).max(30).default(10).describe('How many front-page stories to return (1-30)')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async ({ limit }) => {
            const stories = await api.getTopStories(limit);
            return { content: [{ type: 'text', text: stories.map(describeItem).join('\n\n') }] };
        }
    );

    /**
     * The error-handling lesson.
     *
     * A tool error is a *successful* JSON-RPC result carrying `isError: true`.
     * The model reads it and recovers -- so the text has to tell it how. Here
     * it names where valid ids come from. Compare with `prompts`, below, where
     * a bad argument is a protocol error the model never sees.
     *
     * (A thrown exception gets converted to this same shape by the SDK. Both
     * reach the model; returning is for failures you expected, throwing is for
     * the ones you didn't.)
     */
    server.registerTool(
        'get_story',
        {
            title: 'Read one HN item',
            description: 'Fetch a single Hacker News story, comment or job by its numeric id',
            inputSchema: z.object({
                id: z.number().int().positive().describe('Numeric HN item id, as returned by search_stories or get_top_stories')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async ({ id }) => {
            const item = await api.getItem(id);
            if (!item) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `No Hacker News item with id ${id}. Valid ids come from search_stories or get_top_stories.`
                        }
                    ],
                    isError: true
                };
            }
            return { content: [{ type: 'text', text: describeItem(item) }] };
        }
    );

    // ------------------------------------------------------------ resources

    /** A static resource: one fixed URI, one read callback. */
    server.registerResource(
        'top-stories',
        'hn://top',
        {
            title: 'Hacker News front page',
            description: 'The current front page as JSON, for attaching as context',
            mimeType: 'application/json'
        },
        async uri => {
            const stories = await api.getTopStories(10);
            return {
                contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(stories, null, 2) }]
            };
        }
    );

    /**
     * A resource TEMPLATE registers a whole URI pattern instead of one URI.
     *
     * `list` is a required key even when it's `undefined` -- the SDK forces you
     * to say "these instances are unbounded, don't enumerate them" out loud
     * rather than forgetting listing exists.
     *
     * Matched variables arrive parsed as the second argument, always as
     * STRINGS, hence the `Number(id)`.
     */
    server.registerResource(
        'story',
        new ResourceTemplate('hn://item/{id}', { list: undefined }),
        {
            title: 'One Hacker News item',
            description: 'A single HN item as JSON, addressed by id',
            mimeType: 'application/json'
        },
        async (uri, { id }) => {
            const item = await api.getItem(Number(id));
            // A resource read has no `isError` channel: a missing resource is a
            // protocol-level error, so we throw the SDK's own error type.
            if (!item) throw new ResourceNotFoundError(uri.href);
            return {
                contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(item, null, 2) }]
            };
        }
    );

    // -------------------------------------------------------------- prompts

    /**
     * A prompt is a message template a person invokes by name.
     *
     * Note the failure channel: call this without `id` and the request is
     * rejected as JSON-RPC error -32602 (Invalid params), which the model never
     * sees -- unlike a bad tool argument, which comes back as `isError: true`.
     * Same SDK, two different failure paths, decided by the primitive.
     */
    server.registerPrompt(
        'discuss_story',
        {
            title: 'Summarize an HN discussion',
            description: 'Summarize where the comment thread on a Hacker News story landed',
            argsSchema: z.object({
                id: z.string().describe('Numeric HN story id')
            })
        },
        async ({ id }) => {
            const story = await api.getItem(Number(id));
            if (!story) throw new Error(`No Hacker News item with id ${id}.`);

            const kids = (story.kids ?? []).slice(0, 15);
            const comments = (await Promise.all(kids.map(kid => api.getItem(kid))))
                .filter((c): c is HnItem => c !== null && !c.deleted && !c.dead)
                .map(c => `- ${c.by ?? 'someone'}: ${(c.text ?? '').replace(/<[^>]+>/g, ' ').slice(0, 600)}`)
                .join('\n');

            return {
                messages: [
                    {
                        role: 'user' as const,
                        content: {
                            type: 'text' as const,
                            text: [
                                `Here is a Hacker News story and its top-level comments.`,
                                ``,
                                describeItem(story),
                                ``,
                                `Comments:`,
                                comments || '(no comments yet)',
                                ``,
                                `Summarize where the discussion landed: the main positions, where people`,
                                `disagreed, and anything surprising. Note if the thread is too thin to tell.`
                            ].join('\n')
                        }
                    }
                ]
            };
        }
    );

    return server;
}
