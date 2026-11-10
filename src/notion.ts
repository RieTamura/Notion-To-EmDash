import type { PropertyNames } from "./config.ts";
import type { NotionBlock } from "./convert.ts";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";

/** How many times a request is tried again after 429, 529 or a temporary server error. */
const MAX_RETRIES = 3;

/** How deep nested blocks are read. Deeper content is left out (lists rarely go past a few levels). */
const MAX_DEPTH = 8;

export class NotionError extends Error {
	override name = "NotionError";
	readonly status: number;
	readonly code: string | undefined;

	constructor(status: number, code: string | undefined, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

export interface NotionClientOptions {
	token: string;
	fetch?: FetchLike;
	sleep?: Sleep;
}

/* ---------- Shapes of the Notion objects this tool reads ---------- */

export interface RichText {
	plain_text: string;
}

export interface NotionFile {
	name?: string;
	type: "file" | "external" | "file_upload";
	file?: { url: string; expiry_time?: string };
	external?: { url: string };
}

/** A property value on a page. Only the fields this tool reads are listed. */
export interface PropertyValue {
	id: string;
	type: string;
	title?: RichText[];
	rich_text?: RichText[];
	checkbox?: boolean;
	select?: { name: string } | null;
	multi_select?: { name: string }[];
	files?: NotionFile[];
	url?: string | null;
	date?: { start: string; end: string | null } | null;
}

export interface NotionPage {
	object: "page";
	id: string;
	last_edited_time: string;
	last_edited_by?: { id: string };
	in_trash?: boolean;
	url: string;
	properties: Record<string, PropertyValue>;
}

interface QueryResponse {
	results: (NotionPage | { object: string })[];
	has_more: boolean;
	next_cursor: string | null;
}

interface BlockListResponse {
	results: (NotionBlock & { in_trash?: boolean })[];
	has_more: boolean;
	next_cursor: string | null;
}

/** A property in the data source's schema. */
export interface SchemaProperty {
	id: string;
	name: string;
	type: string;
}

export interface DataSource {
	id: string;
	properties: Record<string, SchemaProperty>;
}

/* ---------- Client ---------- */

export class NotionClient {
	private readonly token: string;
	private readonly fetch: FetchLike;
	private readonly sleep: Sleep;

	constructor(options: NotionClientOptions) {
		this.token = options.token;
		this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** The integration's own user ID. Used to tell this tool's edits from a person's edits. */
	async getBotUserId(): Promise<string> {
		const me = await this.request<{ id: string }>("GET", "/users/me");
		return me.id;
	}

	/**
	 * A database can hold more than one data source (table). This tool uses the first one.
	 * Returns its ID and the names of all of them.
	 */
	async getDataSourceId(databaseId: string): Promise<{ id: string; names: string[] }> {
		const database = await this.request<{ data_sources?: { id: string; name: string }[] }>(
			"GET",
			`/databases/${databaseId}`,
		);
		const sources = database.data_sources ?? [];
		if (sources.length === 0) {
			throw new NotionError(0, undefined, "The database has no data source (table) to read");
		}
		return { id: sources[0]!.id, names: sources.map((source) => source.name) };
	}

	async getDataSource(dataSourceId: string): Promise<DataSource> {
		return this.request<DataSource>("GET", `/data_sources/${dataSourceId}`);
	}

	/** Every page with the publish checkbox ticked, oldest edit first. */
	async queryPublishedPages(dataSourceId: string, publishProperty: string): Promise<NotionPage[]> {
		const pages: NotionPage[] = [];
		let cursor: string | null = null;
		do {
			const body: Record<string, unknown> = {
				filter: { property: publishProperty, checkbox: { equals: true } },
				sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
				page_size: 100,
			};
			if (cursor) body.start_cursor = cursor;
			const response: QueryResponse = await this.request<QueryResponse>(
				"POST",
				`/data_sources/${dataSourceId}/query`,
				body,
			);
			for (const result of response.results) {
				if (result.object === "page") pages.push(result as NotionPage);
			}
			cursor = response.has_more ? response.next_cursor : null;
		} while (cursor);
		return pages;
	}

	/** One level of a block's children, all pages of them. */
	async getBlockChildren(blockId: string): Promise<NotionBlock[]> {
		const blocks: NotionBlock[] = [];
		let cursor: string | null = null;
		do {
			const query: string = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "?page_size=100";
			const response: BlockListResponse = await this.request<BlockListResponse>(
				"GET",
				`/blocks/${blockId}/children${query}`,
			);
			blocks.push(...response.results.filter((block) => !block.in_trash));
			cursor = response.has_more ? response.next_cursor : null;
		} while (cursor);
		return blocks;
	}

	/**
	 * The page's whole body, with each block's children read into `children`.
	 * Sub-pages and databases are not opened: they are separate pages, not part of this article.
	 */
	async getBlockTree(blockId: string, depth = 0): Promise<NotionBlock[]> {
		const blocks = await this.getBlockChildren(blockId);
		if (depth >= MAX_DEPTH) return blocks;
		for (const block of blocks) {
			if (!block.has_children || block.type === "child_page" || block.type === "child_database") continue;
			// A copy of a synced block shows the original's content
			const synced = block.type === "synced_block"
				? (block.synced_block as { synced_from?: { block_id?: string } | null } | undefined)?.synced_from?.block_id
				: undefined;
			block.children = await this.getBlockTree(synced ?? block.id, depth + 1);
		}
		return blocks;
	}

	/** All requests here only read, so they are safe to try again. */
	private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const response = await this.fetch(`${NOTION_API}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Notion-Version": NOTION_VERSION,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.ok) return (await response.json()) as T;

			if (attempt < MAX_RETRIES && isRetryable(response.status)) {
				await this.sleep(retryDelayMs(response, attempt));
				continue;
			}
			throw await toNotionError(response);
		}
	}
}

function isRetryable(status: number): boolean {
	return status === 429 || status === 529 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Retry-After (seconds) when Notion sends it; otherwise 1 s, 2 s, 4 s. */
function retryDelayMs(response: Response, attempt: number): number {
	const header = Number(response.headers.get("Retry-After"));
	if (Number.isFinite(header) && header > 0) return header * 1000;
	return 1000 * 2 ** attempt;
}

async function toNotionError(response: Response): Promise<NotionError> {
	let code: string | undefined;
	let message = `Notion API returned ${response.status}`;
	try {
		const data = (await response.json()) as { code?: string; message?: string };
		code = data.code;
		if (data.message) message = `${message}: ${data.message}`;
	} catch {
		// The body was not JSON; keep the status only.
	}
	if (response.status === 404 || response.status === 403) {
		message += " (check that the database is shared with the integration under Connections)";
	}
	return new NotionError(response.status, code, message);
}

/* ---------- Checking the database ---------- */

/** The type each property must have. The title property is found by its type, not its name. */
const EXPECTED_TYPES: Record<keyof PropertyNames, string> = {
	publish: "checkbox",
	slug: "rich_text",
	excerpt: "rich_text",
	category: "select",
	tags: "multi_select",
	featuredImage: "files",
	emdashUrl: "url",
	sentAt: "date",
};

/** This tool cannot work without these. The others may be left out of the database. */
const REQUIRED_PROPERTIES: (keyof PropertyNames)[] = ["publish", "emdashUrl", "sentAt"];

/** Returns one line per problem; an empty list means the database is ready. */
export function checkSchema(schema: Record<string, SchemaProperty>, names: PropertyNames): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(EXPECTED_TYPES) as (keyof PropertyNames)[]) {
		const name = names[key];
		const property = schema[name];
		if (!property) {
			if (REQUIRED_PROPERTIES.includes(key)) {
				problems.push(`Property "${name}" is missing; add it as type ${EXPECTED_TYPES[key]}`);
			}
			continue;
		}
		if (property.type !== EXPECTED_TYPES[key]) {
			problems.push(`Property "${name}" is type ${property.type}; it must be ${EXPECTED_TYPES[key]}`);
		}
	}
	return problems;
}

/* ---------- Reading a page ---------- */

export interface FeaturedImage {
	url: string;
	name: string | undefined;
	/** Notion-hosted files stop working about an hour after they are read. */
	expires: boolean;
}

export interface Article {
	pageId: string;
	notionUrl: string;
	lastEditedTime: string;
	lastEditedBy: string | undefined;
	title: string;
	slug: string;
	excerpt: string;
	category: string | null;
	tags: string[];
	featuredImage: FeaturedImage | null;
	/** Empty when the page has not been sent yet. */
	emdashUrl: string;
	sentAt: string | null;
}

export function parsePage(page: NotionPage, names: PropertyNames): Article {
	const props = page.properties;
	const titleProperty = Object.values(props).find((value) => value.type === "title");
	return {
		pageId: page.id,
		notionUrl: page.url,
		lastEditedTime: page.last_edited_time,
		lastEditedBy: page.last_edited_by?.id,
		title: plainText(titleProperty?.title).trim(),
		slug: plainText(props[names.slug]?.rich_text).trim(),
		excerpt: plainText(props[names.excerpt]?.rich_text).trim(),
		category: props[names.category]?.select?.name ?? null,
		tags: (props[names.tags]?.multi_select ?? []).map((option) => option.name),
		featuredImage: firstFile(props[names.featuredImage]?.files),
		emdashUrl: props[names.emdashUrl]?.url ?? "",
		sentAt: props[names.sentAt]?.date?.start ?? null,
	};
}

function plainText(parts: RichText[] | undefined): string {
	return (parts ?? []).map((part) => part.plain_text).join("");
}

function firstFile(files: NotionFile[] | undefined): FeaturedImage | null {
	for (const file of files ?? []) {
		if (file.type === "file" && file.file?.url) {
			return { url: file.file.url, name: file.name, expires: true };
		}
		if (file.type === "external" && file.external?.url) {
			return { url: file.external.url, name: file.name, expires: false };
		}
	}
	return null;
}

/* ---------- Deciding what to send ---------- */

/**
 * A page is sent when it has never been sent, or when a person edited it after it was sent.
 *
 * Writing the sent date back changes the page's last edited time too, so comparing times alone
 * would send every page again on every run. The last editor tells the two apart: this tool's
 * write-back is the last thing it does to a page, so if someone else is now the last editor,
 * they edited it after it was sent. This also works when Notion rounds the edit time to the
 * minute. Times are compared only when Notion does not say who edited last.
 */
export function needsSending(article: Article, botUserId: string): boolean {
	if (!article.title) return false;
	if (!article.emdashUrl || !article.sentAt) return true;
	if (article.lastEditedBy) return article.lastEditedBy !== botUserId;
	return Date.parse(article.lastEditedTime) > Date.parse(article.sentAt);
}
