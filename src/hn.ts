/**
 * A thin client for the public Hacker News APIs.
 *
 * There is deliberately no MCP in this file. Keeping the data source separate
 * from the protocol layer makes it obvious, when you reread `server.ts`, which
 * parts are MCP and which parts are just "talking to an API".
 */

/** Firebase item endpoint: stories, comments, jobs, polls all share this shape. */
export interface HnItem {
    id: number;
    type: 'story' | 'comment' | 'job' | 'poll' | 'pollopt';
    by?: string;
    title?: string;
    url?: string;
    text?: string;
    score?: number;
    time?: number;
    descendants?: number;
    kids?: number[];
    deleted?: boolean;
    dead?: boolean;
}

/** The narrow projection we hand back from a search. */
export interface HnStory {
    id: number;
    title: string;
    url: string | null;
    author: string;
    points: number;
    comments: number;
    createdAt: string;
}

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA = 'https://hn.algolia.com/api/v1';

/**
 * One place where HTTP failure becomes a thrown Error. Throwing here is fine:
 * the MCP SDK catches whatever a tool handler throws and converts it into the
 * same `isError: true` result the model sees. See `server.ts`.
 */
async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { 'User-Agent': 'hn-mcp/1.0 (learning project)' } });
    if (!res.ok) {
        throw new Error(`Hacker News API returned HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
}

/**
 * The surface `server.ts` depends on. Depending on an interface rather than on
 * these functions directly is what lets the tests swap in a stub and run with
 * no network -- see `test/server.test.ts`.
 */
export interface HnApi {
    getItem(id: number): Promise<HnItem | null>;
    getTopStoryIds(): Promise<number[]>;
    getTopStories(limit: number): Promise<HnItem[]>;
    searchStories(query: string, limit: number): Promise<HnStory[]>;
}

/**
 * Firebase answers a missing id with literal `null` rather than a 404, so this
 * returns `null` instead of throwing. That distinction is what makes the
 * error-handling lesson in the `get_story` tool a real one.
 */
async function getItem(id: number): Promise<HnItem | null> {
    return await fetchJson<HnItem | null>(`${FIREBASE}/item/${id}.json`);
}

async function getTopStoryIds(): Promise<number[]> {
    return await fetchJson<number[]>(`${FIREBASE}/topstories.json`);
}

/**
 * `topstories.json` returns ~500 ids and no story bodies, so each one needs its
 * own request. We slice first, then fetch the slice concurrently -- which is
 * exactly why the tool that calls this caps `limit` in its input schema instead
 * of trusting the caller: an uncapped limit here is 500 outbound requests.
 */
async function getTopStories(limit: number): Promise<HnItem[]> {
    const ids = await getTopStoryIds();
    const items = await Promise.all(ids.slice(0, limit).map(getItem));
    return items.filter((item): item is HnItem => item !== null);
}

/** Algolia provides the search HN's own Firebase API doesn't. */
async function searchStories(query: string, limit: number): Promise<HnStory[]> {
    const url = `${ALGOLIA}/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
    const { hits } = await fetchJson<{ hits: AlgoliaHit[] }>(url);
    return hits.map(hit => ({
        id: Number(hit.objectID),
        title: hit.title ?? '(untitled)',
        url: hit.url ?? null,
        author: hit.author,
        points: hit.points ?? 0,
        comments: hit.num_comments ?? 0,
        createdAt: hit.created_at
    }));
}

interface AlgoliaHit {
    objectID: string;
    title?: string;
    url?: string;
    author: string;
    points?: number;
    num_comments?: number;
    created_at: string;
}

/** The real implementation, used by both entry points. */
export const liveHnApi: HnApi = { getItem, getTopStoryIds, getTopStories, searchStories };
