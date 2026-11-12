import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const DATABASE_ID = "0123456789abcdef0123456789abcdef";
const SOURCE_ID = "source-1";
const BOT_ID = "bot-user";
const PAGE_ID = "page-1";
const API = "https://api.notion.com/v1";

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rt(text: string) {
	return { type: "text", plain_text: text, text: { content: text }, annotations: {} };
}

function block(id: string, type: string, content: Record<string, unknown>, hasChildren = false) {
	return { object: "block", id, type, has_children: hasChildren, [type]: content };
}

const SCHEMA = {
	id: SOURCE_ID,
	properties: {
		名前: { id: "title", name: "名前", type: "title" },
		公開: { id: "p", name: "公開", type: "checkbox" },
		スラッグ: { id: "s", name: "スラッグ", type: "rich_text" },
		"EmDash URL": { id: "u", name: "EmDash URL", type: "url" },
		送信日時: { id: "d", name: "送信日時", type: "date" },
	},
};

function page(id: string, title: string, extra: Record<string, unknown> = {}) {
	const properties: Record<string, unknown> = {
		名前: { id: "title", type: "title", title: [rt(title)] },
		公開: { id: "p", type: "checkbox", checkbox: true },
		スラッグ: { id: "s", type: "rich_text", rich_text: [rt(`${id}-slug`)] },
		"EmDash URL": { id: "u", type: "url", url: null },
		送信日時: { id: "d", type: "date", date: null },
	};
	return {
		object: "page",
		id,
		url: `https://www.notion.so/${id}`,
		last_edited_time: "2026-11-12T01:00:00.000Z",
		last_edited_by: { id: "person" },
		properties,
		...extra,
	};
}

/** Queues the Notion responses that come before reading a page body. */
async function respondDatabase(h: PluginRuntimeTestHost, pages: unknown[]) {
	await h.http.respond(`${API}/users/me`, json({ object: "user", id: BOT_ID }));
	await h.http.respond(`${API}/databases/${DATABASE_ID}`, json({ data_sources: [{ id: SOURCE_ID, name: "記事" }] }));
	await h.http.respond(`${API}/data_sources/${SOURCE_ID}`, json(SCHEMA));
	await h.http.respond(
		`${API}/data_sources/${SOURCE_ID}/query`,
		json({ results: pages, has_more: false, next_cursor: null }),
	);
}

function children(blockId: string, results: unknown[]) {
	return [`${API}/blocks/${blockId}/children?page_size=100`, json({ results, has_more: false, next_cursor: null })] as const;
}

const CONFIGURED = { notionToken: "secret_token", databaseId: DATABASE_ID };

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function setup(settings: Record<string, string> = {}) {
	host = await createPluginRuntimeTestHost();
	for (const [key, value] of Object.entries(settings)) {
		await host.fixtures.plugin.setting(key, value);
	}
	return host;
}

describe("scheduling", () => {
	it("checks Notion every five minutes by default", async () => {
		const h = await setup();
		await h.actions.plugin.activate();
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/5 * * * *", enabled: 1 })]),
		);
	});

	it("uses the interval from the settings", async () => {
		const h = await setup({ schedule: "*/15 * * * *" });
		await h.actions.plugin.activate();
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/15 * * * *" })]),
		);
	});
});

describe("sync", () => {
	it("does nothing until the token and the database are set", async () => {
		const h = await setup();
		expect(await h.transport.invokeRoute("sync", {}, { method: "POST" })).toEqual({
			status: "not_configured",
			missing: ["notionToken", "databaseId"],
		});
	});

	it("accepts a database link as well as an ID", async () => {
		const h = await setup({
			notionToken: "secret",
			databaseId: `https://www.notion.so/space/Posts-${DATABASE_ID}?v=fedcba9876543210fedcba9876543210`,
		});
		await h.http.respond(`${API}/users/me`, json({ object: "error", code: "unauthorized", message: "API token is invalid." }, 401));
		// Getting as far as asking Notion means the link was read as the database ID.
		expect(await h.transport.invokeRoute("sync", {}, { method: "POST" })).toMatchObject({ status: "notion_error", httpStatus: 401 });
	});
});

describe("preview", () => {
	it("reads the oldest page to send through the plugin bridge and converts its body", async () => {
		const h = await setup(CONFIGURED);
		await respondDatabase(h, [page(PAGE_ID, "はじめての記事"), page("page-2", "次の記事")]);
		await h.http.respond(
			...children(PAGE_ID, [
				block("b1", "heading_1", { rich_text: [rt("見出し")] }),
				block("b2", "bulleted_list_item", { rich_text: [rt("親")] }, true),
				block("b3", "image", { type: "file", file: { url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/a.png" }, caption: [] }),
				block("b4", "child_database", { title: "表" }),
			]),
		);
		await h.http.respond(...children("b2", [block("b5", "bulleted_list_item", { rich_text: [rt("子")] })]));

		const result = await h.transport.invokeRoute("preview", {}, { method: "POST" });

		expect(result).toMatchObject({
			status: "ready",
			page: { id: PAGE_ID, title: "はじめての記事", slug: `${PAGE_ID}-slug` },
			images: 1,
			waiting: 1,
		});
		expect((result as { blocks: number }).blocks).toBeGreaterThanOrEqual(4);
		expect((result as { skipped: { type: string }[] }).skipped).toEqual([expect.objectContaining({ type: "child_database" })]);

		const requests = h.http.requests();
		expect(requests.every((request) => request.headers.authorization === "Bearer secret_token")).toBe(true);
		expect(requests.find((request) => request.url.endsWith("/query"))?.method).toBe("POST");
		// Nothing is written while previewing.
		expect(requests.filter((request) => request.method === "PATCH")).toEqual([]);
	});

	it("skips a page the plugin sent last and nobody edited since", async () => {
		const h = await setup(CONFIGURED);
		const sent = page(PAGE_ID, "送った記事", { last_edited_by: { id: BOT_ID } });
		sent.properties["EmDash URL"] = { id: "u", type: "url", url: "https://example.com/posts/page-1-slug" };
		sent.properties["送信日時"] = { id: "d", type: "date", date: { start: "2026-11-12T01:00:00.000Z", end: null } };
		await respondDatabase(h, [sent]);

		expect(await h.transport.invokeRoute("preview", {}, { method: "POST" })).toEqual({ status: "nothing_to_send" });
	});

	it("says which database properties are missing", async () => {
		const h = await setup(CONFIGURED);
		await h.http.respond(`${API}/users/me`, json({ object: "user", id: BOT_ID }));
		await h.http.respond(`${API}/databases/${DATABASE_ID}`, json({ data_sources: [{ id: SOURCE_ID, name: "記事" }] }));
		await h.http.respond(`${API}/data_sources/${SOURCE_ID}`, json({ id: SOURCE_ID, properties: { 名前: SCHEMA.properties.名前 } }));

		const result = await h.transport.invokeRoute("preview", {}, { method: "POST" });
		expect(result).toMatchObject({ status: "schema_invalid" });
		expect(JSON.stringify(result)).toContain("公開");
	});

	it("reports a wrong token instead of failing", async () => {
		const h = await setup(CONFIGURED);
		await h.http.respond(`${API}/users/me`, json({ object: "error", code: "unauthorized", message: "API token is invalid." }, 401));

		expect(await h.transport.invokeRoute("preview", {}, { method: "POST" })).toMatchObject({
			status: "notion_error",
			httpStatus: 401,
			code: "unauthorized",
		});
	});
});
