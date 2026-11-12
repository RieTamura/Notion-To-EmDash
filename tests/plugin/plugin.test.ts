import { afterEach, describe, expect, it } from "vitest";

import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import {
	API,
	BOT_ID,
	CONFIGURED,
	createSite,
	DATABASE_ID,
	json,
	page,
	paragraph,
	respondChildren,
	respondDatabase,
	respondPages,
	SCHEMA,
	SOURCE_ID,
} from "./fixtures.ts";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const unauthorized = () => json({ object: "error", code: "unauthorized", message: "API token is invalid." }, 401);

async function check(h: PluginRuntimeTestHost) {
	return h.transport.invokeRoute("check", {}, { method: "POST" });
}

/** All text on an admin page, to look for messages in. */
function pageText(response: { blocks: unknown[]; toast?: unknown }) {
	return JSON.stringify(response);
}

async function respondMissingProperties(h: PluginRuntimeTestHost) {
	await h.http.respond(`${API}/users/me`, json({ object: "user", id: BOT_ID }));
	await h.http.respond(`${API}/databases/${DATABASE_ID}`, json({ data_sources: [{ id: SOURCE_ID, name: "記事" }] }));
	await h.http.respond(`${API}/data_sources/${SOURCE_ID}`, json({ id: SOURCE_ID, properties: { 名前: SCHEMA.properties.名前 } }));
}

describe("scheduling", () => {
	it("checks Notion every five minutes by default", async () => {
		const h = (host = await createSite());
		await h.actions.plugin.activate();
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/5 * * * *", enabled: 1 })]),
		);
	});

	it("uses the interval from the settings", async () => {
		const h = (host = await createSite({ schedule: "*/15 * * * *" }));
		await h.actions.plugin.activate();
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/15 * * * *" })]),
		);
	});
});

describe("sync and check routes", () => {
	it("do nothing until the token and the database are set", async () => {
		const h = (host = await createSite());
		const expected = { status: "not_configured", missing: ["notionToken", "databaseId"] };
		expect(await h.transport.invokeRoute("sync", {}, { method: "POST" })).toEqual(expected);
		expect(await check(h)).toEqual(expected);
	});

	it("accept a database link as well as an ID", async () => {
		const h = (host = await createSite({
			notionToken: "secret",
			databaseId: `https://www.notion.so/space/Posts-${DATABASE_ID}?v=fedcba9876543210fedcba9876543210`,
		}));
		await respondDatabase(h);
		await respondPages(h, [], { mark: false });
		expect(await check(h)).toEqual({ status: "ok", toSend: 0, waitingForEdit: 0 });
	});

	it("check counts the pages to send without sending or writing anything", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(
			h,
			[
				page("p1", "まだ送っていない"),
				page("p2", "送ったまま", { editedBy: BOT_ID, emdashUrl: "https://example.com/posts/x", sentAt: "2026-11-12T00:00:00.000Z" }),
			],
			{ mark: false },
		);

		expect(await check(h)).toEqual({ status: "ok", toSend: 1, waitingForEdit: 0 });
		expect(h.http.requests().filter((request) => request.method === "PATCH")).toEqual([]);
		expect(await h.inspect.content.list("posts")).toHaveLength(0);
	});

	it("check reads the database again, so a fixed database is noticed", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [], { mark: false });
		await check(h);
		h.http.clear();

		await respondDatabase(h);
		await respondPages(h, [], { mark: false });
		await check(h);
		expect(h.http.requests().map((request) => new URL(request.url).pathname)).toContain("/v1/users/me");
	});

	it("check lists the database properties that are missing", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondMissingProperties(h);
		const result = await check(h);
		expect(result).toMatchObject({ status: "schema_invalid" });
		expect(JSON.stringify(result)).toContain("公開");
	});

	it("a wrong token is reported, not thrown", async () => {
		const h = (host = await createSite(CONFIGURED));
		await h.http.respond(`${API}/users/me`, unauthorized());
		expect(await check(h)).toMatchObject({ status: "notion_error", httpStatus: 401, code: "unauthorized" });
	});
});

describe("admin page", () => {
	it("asks for the token and the database first, in Japanese for a Japanese admin", async () => {
		const h = (host = await createSite());
		const text = pageText(await h.admin.loadPage("/settings", { locale: "ja" }));
		expect(text).toContain("Notion のトークンとデータベースを入れて保存してください");
		expect(text).toContain("secret_input");
		expect(text).toContain("まだ動いていません");
	});

	it("is in English for other admins", async () => {
		const h = (host = await createSite());
		expect(pageText(await h.admin.loadPage("/settings", { locale: "en" }))).toContain("Enter the Notion token and the database");
	});

	it("saves the settings and moves the cron task to the new interval", async () => {
		const h = (host = await createSite());
		await h.actions.plugin.activate();
		const response = await h.admin.submit(
			"/settings",
			"save",
			{
				notionToken: "secret_new",
				databaseId: `https://www.notion.so/space/Posts-${DATABASE_ID}`,
				mode: "draft",
				schedule: "*/10 * * * *",
			},
			{ blockId: "settings", locale: "ja" },
		);

		expect(response.toast).toEqual({ type: "success", message: "保存しました" });
		// Stored encrypted, not as plain text…
		const stored = await h.inspect.setting("notionToken");
		expect(stored).toMatchObject({ $emdash: "plugin-setting" });
		expect(JSON.stringify(stored)).not.toContain("secret_new");
		// …and the plugin still reads the token when it calls Notion.
		await h.http.respond(`${API}/users/me`, unauthorized());
		await check(h);
		expect(h.http.requests()[0]?.headers.authorization).toBe("Bearer secret_new");
		expect(await h.inspect.setting("mode")).toBe("draft");
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/10 * * * *" })]),
		);
		// The token is never sent back to the browser.
		expect(pageText(response)).not.toContain("secret_new");
		expect(pageText(response)).toContain('"has_value":true');
	});

	it("says what to do when the site cannot encrypt the token", async () => {
		const h = (host = await createSite());
		const key = process.env.EMDASH_ENCRYPTION_KEY;
		delete process.env.EMDASH_ENCRYPTION_KEY;
		try {
			const response = await h.admin.submit(
				"/settings",
				"save",
				{ notionToken: "secret_new", databaseId: DATABASE_ID, mode: "publish", schedule: "" },
				{ blockId: "settings", locale: "ja" },
			);
			expect(response.toast).toMatchObject({ type: "error", message: expect.stringContaining("EMDASH_ENCRYPTION_KEY") });
		} finally {
			process.env.EMDASH_ENCRYPTION_KEY = key;
		}
		expect(await h.inspect.setting("notionToken")).toBeNull();
	});

	it("keeps the saved token when the token field is left empty", async () => {
		const h = (host = await createSite(CONFIGURED));
		await h.admin.submit(
			"/settings",
			"save",
			{ notionToken: "", databaseId: DATABASE_ID, mode: "publish", schedule: "" },
			{ blockId: "settings" },
		);
		expect(await h.inspect.setting("notionToken")).toBe(CONFIGURED.notionToken);
	});

	it("refuses a database it cannot read and an interval that is not cron", async () => {
		const h = (host = await createSite());
		const badDatabase = await h.admin.submit("/settings", "save", { databaseId: "not a database", schedule: "" }, { blockId: "settings", locale: "ja" });
		expect(badDatabase.toast).toMatchObject({ type: "error", message: expect.stringContaining("データベース") });

		const badSchedule = await h.admin.submit(
			"/settings",
			"save",
			{ databaseId: DATABASE_ID, schedule: "every five minutes" },
			{ blockId: "settings", locale: "ja" },
		);
		expect(badSchedule.toast).toMatchObject({ type: "error", message: expect.stringContaining("*/5 * * * *") });
		expect(await h.inspect.setting("databaseId")).toBeNull();
	});

	it("explains a wrong token after checking the connection", async () => {
		const h = (host = await createSite(CONFIGURED));
		await h.http.respond(`${API}/users/me`, unauthorized());
		expect(pageText(await h.admin.act("/settings", "check", { locale: "ja" }))).toContain("トークンが違います");
	});

	it("explains a database the integration cannot see", async () => {
		const h = (host = await createSite(CONFIGURED));
		await h.http.respond(`${API}/users/me`, json({ object: "user", id: BOT_ID }));
		await h.http.respond(
			`${API}/databases/${DATABASE_ID}`,
			json({ object: "error", code: "object_not_found", message: "Could not find database" }, 404),
		);
		expect(pageText(await h.admin.act("/settings", "check", { locale: "ja" }))).toContain("データベースが見つかりません");
	});

	it("shows the missing database properties", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondMissingProperties(h);
		const text = pageText(await h.admin.act("/settings", "check", { locale: "ja" }));
		expect(text).toContain("データベースの準備ができていません");
		expect(text).toContain("公開");
	});

	it("sends a page with the Send now button and lists pages that could not be sent", async () => {
		const h = (host = await createSite(CONFIGURED));
		const pages = [page("p1", "カテゴリが違う", { category: "ない" }), page("p2", "送れる記事")];
		await respondDatabase(h);
		await respondPages(h, pages);
		await respondChildren(h, "p1", [paragraph("a", "本文")]);
		await respondChildren(h, "p2", [paragraph("b", "本文")]);

		const first = pageText(await h.admin.act("/settings", "run_now", { locale: "ja" }));
		expect(first).toContain("送れなかったページ");
		expect(first).toContain("カテゴリが違う");

		await respondPages(h, pages);
		let response = await h.admin.act("/settings", "run_now", { locale: "ja" });
		for (let i = 0; i < 3 && !response.toast; i++) response = await h.admin.act("/settings", "run_now", { locale: "ja" });
		expect(response.toast).toEqual({ type: "success", message: "「送れる記事」を送りました" });
	});

	it("removes the token", async () => {
		const h = (host = await createSite(CONFIGURED));
		const response = await h.admin.act("/settings", "clear_token", { locale: "ja" });
		expect(response.toast).toEqual({ type: "info", message: "トークンを消しました" });
		expect(await h.inspect.setting("notionToken")).toBeNull();
	});
});
