import { describe, expect, it } from "vitest";
import { DEFAULT_PROPERTY_NAMES } from "../src/config.ts";
import {
	type Article,
	checkSchema,
	type FetchLike,
	NOTION_VERSION,
	NotionClient,
	NotionError,
	type NotionPage,
	needsSending,
	parsePage,
	type SchemaProperty,
} from "../src/notion.ts";

const names = DEFAULT_PROPERTY_NAMES;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function fakeFetch(responses: Response[]): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			const next = responses.shift();
			if (!next) throw new Error(`Unexpected request: ${url}`);
			return next;
		},
	};
}

const noSleep = async () => {};

describe("NotionClient", () => {
	it("sends the token and the API version", async () => {
		const { fetch, calls } = fakeFetch([json({ id: "bot-1" })]);
		const client = new NotionClient({ token: "ntn_secret", fetch, sleep: noSleep });
		expect(await client.getBotUserId()).toBe("bot-1");
		const headers = calls[0]!.init!.headers as Record<string, string>;
		expect(calls[0]!.url).toBe("https://api.notion.com/v1/users/me");
		expect(headers.Authorization).toBe("Bearer ntn_secret");
		expect(headers["Notion-Version"]).toBe(NOTION_VERSION);
	});

	it("takes the first data source of the database", async () => {
		const { fetch, calls } = fakeFetch([
			json({ data_sources: [{ id: "ds-1", name: "記事" }, { id: "ds-2", name: "下書き" }] }),
		]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		expect(await client.getDataSourceId("db1")).toEqual({ id: "ds-1", names: ["記事", "下書き"] });
		expect(calls[0]!.url).toBe("https://api.notion.com/v1/databases/db1");
	});

	it("fails clearly when the database has no data source", async () => {
		const { fetch } = fakeFetch([json({ data_sources: [] })]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		await expect(client.getDataSourceId("db1")).rejects.toThrow("no data source");
	});

	it("queries ticked pages page by page and skips non-page results", async () => {
		const { fetch, calls } = fakeFetch([
			json({
				results: [{ object: "page", id: "p1" }, { object: "data_source", id: "x" }],
				has_more: true,
				next_cursor: "c2",
			}),
			json({ results: [{ object: "page", id: "p2" }], has_more: false, next_cursor: null }),
		]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		const pages = await client.queryPublishedPages("ds-1", "公開");
		expect(pages.map((page) => page.id)).toEqual(["p1", "p2"]);

		expect(calls[0]!.url).toBe("https://api.notion.com/v1/data_sources/ds-1/query");
		expect(calls[0]!.init!.method).toBe("POST");
		const first = JSON.parse(calls[0]!.init!.body as string);
		expect(first.filter).toEqual({ property: "公開", checkbox: { equals: true } });
		expect(first.sorts).toEqual([{ timestamp: "last_edited_time", direction: "ascending" }]);
		expect(first.start_cursor).toBeUndefined();
		expect(JSON.parse(calls[1]!.init!.body as string).start_cursor).toBe("c2");
	});

	it("waits for Retry-After on 429 and tries again", async () => {
		const waits: number[] = [];
		const { fetch, calls } = fakeFetch([
			json({ code: "rate_limited", message: "slow down" }, 429, { "Retry-After": "2" }),
			json({ id: "bot-1" }),
		]);
		const client = new NotionClient({
			token: "t",
			fetch,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(await client.getBotUserId()).toBe("bot-1");
		expect(calls).toHaveLength(2);
		expect(waits).toEqual([2000]);
	});

	it("gives up after three retries", async () => {
		const { fetch, calls } = fakeFetch([
			json({}, 503),
			json({}, 503),
			json({}, 503),
			json({ code: "service_unavailable", message: "down" }, 503),
		]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		await expect(client.getBotUserId()).rejects.toThrow("Notion API returned 503: down");
		expect(calls).toHaveLength(4);
	});

	it("explains a 404 as a missing connection and does not retry", async () => {
		const { fetch, calls } = fakeFetch([
			json({ code: "object_not_found", message: "Could not find database" }, 404),
		]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		const error = await client.getDataSourceId("db1").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NotionError);
		expect((error as NotionError).code).toBe("object_not_found");
		expect((error as NotionError).message).toContain("Connections");
		expect(calls).toHaveLength(1);
	});
});

function prop(name: string, type: string): SchemaProperty {
	return { id: name, name, type };
}

describe("checkSchema", () => {
	const full: Record<string, SchemaProperty> = {
		名前: prop("名前", "title"),
		公開: prop("公開", "checkbox"),
		スラッグ: prop("スラッグ", "rich_text"),
		抜粋: prop("抜粋", "rich_text"),
		カテゴリ: prop("カテゴリ", "select"),
		タグ: prop("タグ", "multi_select"),
		アイキャッチ: prop("アイキャッチ", "files"),
		"EmDash URL": prop("EmDash URL", "url"),
		送信日時: prop("送信日時", "date"),
	};

	it("accepts the planned database", () => {
		expect(checkSchema(full, names)).toEqual([]);
	});

	it("allows optional properties to be left out", () => {
		const minimal = {
			名前: full["名前"]!,
			公開: full["公開"]!,
			"EmDash URL": full["EmDash URL"]!,
			送信日時: full["送信日時"]!,
		};
		expect(checkSchema(minimal, names)).toEqual([]);
	});

	it("names missing required properties and wrong types", () => {
		const broken: Record<string, SchemaProperty> = { ...full, タグ: prop("タグ", "select") };
		delete broken["送信日時"];
		expect(checkSchema(broken, names)).toEqual([
			'Property "タグ" is type select; it must be multi_select',
			'Property "送信日時" is missing; add it as type date',
		]);
	});
});

function page(properties: NotionPage["properties"] = {}): NotionPage {
	return {
		object: "page",
		id: "page-1",
		last_edited_time: "2026-11-09T10:00:00.000Z",
		last_edited_by: { id: "person-1" },
		url: "https://www.notion.so/page-1",
		properties: {
			名前: { id: "title", type: "title", title: [{ plain_text: "はじめての" }, { plain_text: "記事" }] },
			...properties,
		},
	};
}

describe("parsePage", () => {
	it("reads every planned property", () => {
		const article = parsePage(
			page({
				公開: { id: "a", type: "checkbox", checkbox: true },
				スラッグ: { id: "b", type: "rich_text", rich_text: [{ plain_text: " first-post " }] },
				抜粋: { id: "c", type: "rich_text", rich_text: [{ plain_text: "短い説明" }] },
				カテゴリ: { id: "d", type: "select", select: { name: "日記" } },
				タグ: { id: "e", type: "multi_select", multi_select: [{ name: "Notion" }, { name: "EmDash" }] },
				アイキャッチ: {
					id: "f",
					type: "files",
					files: [
						{
							name: "cover.png",
							type: "file",
							file: { url: "https://files.notion.so/cover.png", expiry_time: "2026-11-09T11:00:00.000Z" },
						},
					],
				},
				"EmDash URL": { id: "g", type: "url", url: "https://example.com/posts/first-post" },
				送信日時: { id: "h", type: "date", date: { start: "2026-11-09T09:00:00.000Z", end: null } },
			}),
			names,
		);
		expect(article).toEqual({
			pageId: "page-1",
			notionUrl: "https://www.notion.so/page-1",
			lastEditedTime: "2026-11-09T10:00:00.000Z",
			lastEditedBy: "person-1",
			title: "はじめての記事",
			slug: "first-post",
			excerpt: "短い説明",
			category: "日記",
			tags: ["Notion", "EmDash"],
			featuredImage: { url: "https://files.notion.so/cover.png", name: "cover.png", expires: true },
			emdashUrl: "https://example.com/posts/first-post",
			sentAt: "2026-11-09T09:00:00.000Z",
		});
	});

	it("treats missing or empty properties as empty", () => {
		const article = parsePage(page({ カテゴリ: { id: "d", type: "select", select: null } }), names);
		expect(article.slug).toBe("");
		expect(article.excerpt).toBe("");
		expect(article.category).toBeNull();
		expect(article.tags).toEqual([]);
		expect(article.featuredImage).toBeNull();
		expect(article.emdashUrl).toBe("");
		expect(article.sentAt).toBeNull();
	});

	it("reads an image link as a file that does not expire", () => {
		const article = parsePage(
			page({
				アイキャッチ: {
					id: "f",
					type: "files",
					files: [{ name: "x", type: "external", external: { url: "https://img.example/x.jpg" } }],
				},
			}),
			names,
		);
		expect(article.featuredImage).toEqual({ url: "https://img.example/x.jpg", name: "x", expires: false });
	});

	it("finds the title by type, whatever its name", () => {
		const article = parsePage(
			{ ...page(), properties: { Title: { id: "title", type: "title", title: [{ plain_text: "English" }] } } },
			names,
		);
		expect(article.title).toBe("English");
	});
});

describe("needsSending", () => {
	const BOT = "bot-1";
	const sent: Article = {
		pageId: "p",
		notionUrl: "u",
		lastEditedTime: "2026-11-09T10:00:00.000Z",
		lastEditedBy: BOT,
		title: "記事",
		slug: "",
		excerpt: "",
		category: null,
		tags: [],
		featuredImage: null,
		emdashUrl: "https://example.com/posts/a",
		sentAt: "2026-11-09T10:00:30.000Z",
	};

	it("sends a page that was never sent", () => {
		expect(needsSending({ ...sent, emdashUrl: "", sentAt: null, lastEditedBy: "person" }, BOT)).toBe(true);
	});

	it("does not send again after its own write-back", () => {
		expect(needsSending({ ...sent, lastEditedTime: "2026-11-09T10:01:00.000Z" }, BOT)).toBe(false);
	});

	it("sends again when a person edited after sending, even within the same minute", () => {
		expect(needsSending({ ...sent, lastEditedBy: "person" }, BOT)).toBe(true);
	});

	it("compares times when the last editor is unknown", () => {
		expect(needsSending({ ...sent, lastEditedBy: undefined, lastEditedTime: "2026-11-09T10:05:00.000Z" }, BOT)).toBe(
			true,
		);
		expect(needsSending({ ...sent, lastEditedBy: undefined }, BOT)).toBe(false);
	});

	it("never sends a page without a title", () => {
		expect(needsSending({ ...sent, title: "", emdashUrl: "" }, BOT)).toBe(false);
	});
});

describe("NotionClient.getBlockTree", () => {
	it("reads children page by page, goes into nested blocks, and skips trashed blocks", async () => {
		const { fetch, calls } = fakeFetch([
			json({
				results: [
					{ id: "a", type: "bulleted_list_item", has_children: true },
					{ id: "gone", type: "paragraph", has_children: false, in_trash: true },
				],
				has_more: true,
				next_cursor: "c2",
			}),
			json({ results: [{ id: "b", type: "paragraph", has_children: false }], has_more: false, next_cursor: null }),
			json({ results: [{ id: "a1", type: "bulleted_list_item", has_children: false }], has_more: false, next_cursor: null }),
		]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		const tree = await client.getBlockTree("page");
		expect(tree.map((b) => b.id)).toEqual(["a", "b"]);
		expect(tree[0]!.children!.map((b) => b.id)).toEqual(["a1"]);
		expect(calls.map((c) => c.url)).toEqual([
			"https://api.notion.com/v1/blocks/page/children?page_size=100",
			"https://api.notion.com/v1/blocks/page/children?page_size=100&start_cursor=c2",
			"https://api.notion.com/v1/blocks/a/children?page_size=100",
		]);
	});

	it("does not open sub-pages, and reads a synced copy from its original", async () => {
		const { fetch, calls } = fakeFetch([
			json({
				results: [
					{ id: "sub", type: "child_page", has_children: true },
					{ id: "copy", type: "synced_block", has_children: true, synced_block: { synced_from: { type: "block_id", block_id: "orig" } } },
				],
				has_more: false,
				next_cursor: null,
			}),
			json({ results: [{ id: "o1", type: "paragraph", has_children: false }], has_more: false, next_cursor: null }),
		]);
		const client = new NotionClient({ token: "t", fetch, sleep: noSleep });
		const tree = await client.getBlockTree("page");
		expect(tree[0]!.children).toBeUndefined();
		expect(tree[1]!.children!.map((b) => b.id)).toEqual(["o1"]);
		expect(calls[1]!.url).toBe("https://api.notion.com/v1/blocks/orig/children?page_size=100");
	});
});
