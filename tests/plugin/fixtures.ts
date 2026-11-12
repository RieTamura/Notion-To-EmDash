import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

export const DATABASE_ID = "0123456789abcdef0123456789abcdef";
export const SOURCE_ID = "source-1";
export const BOT_ID = "bot-user";
export const API = "https://api.notion.com/v1";
export const SITE = "https://example.com";
export const FILES = "https://prod-files-secure.s3.us-west-2.amazonaws.com";
export const CONFIGURED = { notionToken: "secret_token", databaseId: DATABASE_ID };

/** A 1×1 PNG. */
export const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
	(c) => c.charCodeAt(0),
);

export function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function png() {
	return new Response(PNG, { headers: { "content-type": "image/png" } });
}

export function rt(text: string) {
	return { type: "text", plain_text: text, text: { content: text }, annotations: {} };
}

export function block(id: string, type: string, content: Record<string, unknown>, hasChildren = false) {
	return { object: "block", id, type, has_children: hasChildren, [type]: content };
}

export function paragraph(id: string, text: string, hasChildren = false) {
	return block(id, "paragraph", { rich_text: [rt(text)] }, hasChildren);
}

export function image(id: string, url: string, type: "file" | "external" = "file") {
	return block(id, "image", { type, [type]: { url }, caption: [] });
}

export const SCHEMA = {
	id: SOURCE_ID,
	properties: {
		名前: { id: "title", name: "名前", type: "title" },
		公開: { id: "p", name: "公開", type: "checkbox" },
		スラッグ: { id: "s", name: "スラッグ", type: "rich_text" },
		抜粋: { id: "e", name: "抜粋", type: "rich_text" },
		カテゴリ: { id: "c", name: "カテゴリ", type: "select" },
		タグ: { id: "t", name: "タグ", type: "multi_select" },
		"EmDash URL": { id: "u", name: "EmDash URL", type: "url" },
		送信日時: { id: "d", name: "送信日時", type: "date" },
	},
};

export interface PageOptions {
	editedBy?: string;
	edited?: string;
	excerpt?: string;
	category?: string;
	tags?: string[];
	emdashUrl?: string;
	sentAt?: string;
}

export function page(id: string, title: string, options: PageOptions = {}) {
	return {
		object: "page",
		id,
		url: `https://www.notion.so/${id}`,
		last_edited_time: options.edited ?? "2026-11-12T01:00:00.000Z",
		last_edited_by: { id: options.editedBy ?? "person" },
		properties: {
			名前: { id: "title", type: "title", title: [rt(title)] },
			公開: { id: "p", type: "checkbox", checkbox: true },
			スラッグ: { id: "s", type: "rich_text", rich_text: [rt(`${id}-slug`)] },
			抜粋: { id: "e", type: "rich_text", rich_text: options.excerpt ? [rt(options.excerpt)] : [] },
			カテゴリ: { id: "c", type: "select", select: options.category ? { name: options.category } : null },
			タグ: { id: "t", type: "multi_select", multi_select: (options.tags ?? []).map((name) => ({ name })) },
			"EmDash URL": { id: "u", type: "url", url: options.emdashUrl ?? null },
			送信日時: { id: "d", type: "date", date: options.sentAt ? { start: options.sentAt, end: null } : null },
		},
	};
}

/** The requests made before choosing a page: who the integration is, the database, its schema. */
export async function respondDatabase(h: PluginRuntimeTestHost) {
	await h.http.respond(`${API}/users/me`, json({ object: "user", id: BOT_ID }));
	await h.http.respond(`${API}/databases/${DATABASE_ID}`, json({ data_sources: [{ id: SOURCE_ID, name: "記事" }] }));
	await h.http.respond(`${API}/data_sources/${SOURCE_ID}`, json(SCHEMA));
}

export async function respondPages(h: PluginRuntimeTestHost, pages: unknown[]) {
	await h.http.respond(`${API}/data_sources/${SOURCE_ID}/query`, json({ results: pages, has_more: false, next_cursor: null }));
}

export async function respondChildren(h: PluginRuntimeTestHost, blockId: string, results: unknown[]) {
	await h.http.respond(
		`${API}/blocks/${blockId}/children?page_size=100`,
		json({ results, has_more: false, next_cursor: null }),
	);
}

/** A site with a posts collection, categories and tags. */
export async function createSite(settings: Record<string, string> = {}, options: { posts?: boolean } = {}) {
	const host = await createPluginRuntimeTestHost();
	await host.fixtures.site({ url: SITE, name: "Test" });
	if (options.posts !== false) {
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			supports: ["drafts", "revisions"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "content", label: "Content", type: "portableText" },
				{ slug: "excerpt", label: "Excerpt", type: "text" },
				{ slug: "featured_image", label: "Featured image", type: "image" },
			],
		} as never);
		await host.fixtures.taxonomyDefinition({ name: "category", label: "Categories", hierarchical: true, collections: ["posts"] });
		await host.fixtures.taxonomyDefinition({ name: "tag", label: "Tags", collections: ["posts"] });
	}
	for (const [key, value] of Object.entries(settings)) {
		await host.fixtures.plugin.setting(key, value);
	}
	return host;
}

export async function sync(h: PluginRuntimeTestHost) {
	return (await h.transport.invokeRoute("sync", {}, { method: "POST" })) as Record<string, unknown> & { status: string; calls?: number };
}

/** Runs until a page is sent or something other than progress comes back. */
export async function syncUntilDone(h: PluginRuntimeTestHost, maxRuns = 10) {
	const runs: Array<Record<string, unknown> & { status: string; calls?: number }> = [];
	for (let i = 0; i < maxRuns; i++) {
		const result = await sync(h);
		runs.push(result);
		if (result.status !== "working") break;
	}
	return runs;
}
