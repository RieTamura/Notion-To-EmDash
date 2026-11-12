import { afterEach, describe, expect, it } from "vitest";

import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import {
	API,
	BOT_ID,
	CONFIGURED,
	createSite,
	json,
	page,
	paragraph,
	respondChildren,
	respondDatabase,
	respondMark,
	respondPages,
	SITE,
	sync,
	syncUntilDone,
} from "./fixtures.ts";

const PAGE_ID = "page-1";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

function patches(h: PluginRuntimeTestHost) {
	return h.http
		.requests()
		.filter((request) => request.method === "PATCH")
		.map((request) => ({ url: request.url, body: JSON.parse(new TextDecoder().decode(request.body)) }));
}

describe("writing the mark back to Notion", () => {
	it("writes the post's URL and the time to the page once the post is saved", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "Hello world")]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);

		const runs = await syncUntilDone(h);

		const sent = runs.at(-1)!;
		expect(sent).toMatchObject({ status: "sent", marked: true });
		const post = (await h.inspect.content.list("posts"))[0]!;
		expect(sent.url).toBe(`${SITE}/posts/${post.slug}`);
		const [mark] = patches(h);
		expect(mark?.url).toBe(`${API}/pages/${PAGE_ID}`);
		expect(mark?.body.properties["EmDash URL"]).toEqual({ url: sent.url });
		expect(mark?.body.properties["送信日時"].date.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("does not send the page again after marking it, until a person edits it", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "一度だけ")]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);
		const first = (await syncUntilDone(h)).at(-1)!;

		// Notion now says the plugin edited the page last.
		const marked = { emdashUrl: String(first.url), sentAt: "2026-11-12T03:00:00.000Z" };
		await respondPages(h, [page(PAGE_ID, "一度だけ", { ...marked, editedBy: BOT_ID })], { mark: false });
		expect(await sync(h)).toMatchObject({ status: "nothing_to_send" });

		// A person edits it: it is sent again, to the same post.
		await respondPages(h, [page(PAGE_ID, "直した", { ...marked, edited: "2026-11-12T04:00:00.000Z" })]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "直した本文")]);
		expect((await syncUntilDone(h)).at(-1)).toMatchObject({ status: "sent", created: false, marked: true });
		const posts = await h.inspect.content.list("posts");
		expect(posts).toHaveLength(1);
		expect(posts[0]?.data.title).toBe("直した");
	});

	it("leaves the mark off when the page was edited while it was being sent, so the edit goes next run", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		const original = page(PAGE_ID, "書きかけ");
		await respondPages(h, [original], { mark: false });
		await respondChildren(h, PAGE_ID, [paragraph("p", "一回目")]);
		const newer = page(PAGE_ID, "書きかけ", { edited: "2026-11-12T01:05:00.000Z" });
		await h.http.respond(`${API}/pages/${PAGE_ID}`, json(newer));

		const sent = (await syncUntilDone(h)).at(-1)!;

		expect(sent).toMatchObject({ status: "sent", marked: false });
		expect(String(sent.note)).toContain("edited while it was being sent");
		expect(patches(h)).toEqual([]);

		await respondPages(h, [newer]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "二回目")]);
		expect((await syncUntilDone(h)).at(-1)).toMatchObject({ status: "sent", created: false, marked: true });
		expect(await h.inspect.content.list("posts")).toHaveLength(1);
	});

	it("keeps the post but waits for an edit when Notion refuses the mark", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		const notionPage = page(PAGE_ID, "書き込めない");
		await respondPages(h, [notionPage], { mark: false });
		await respondMark(
			h,
			notionPage,
			json({ object: "error", code: "restricted_resource", message: "Insufficient permissions for this endpoint." }, 403),
		);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);

		const sent = (await syncUntilDone(h)).at(-1)!;

		expect(sent).toMatchObject({ status: "sent", marked: false });
		expect(String(sent.note)).toContain("by hand");
		expect(await h.inspect.content.list("posts")).toHaveLength(1);
		expect(await h.inspect.storage.get("pages", PAGE_ID)).toMatchObject({ failedEdit: notionPage.last_edited_time });

		// Still unmarked in Notion, but it is not sent again on every run.
		await respondPages(h, [notionPage], { mark: false });
		expect(await sync(h)).toMatchObject({ status: "nothing_to_send" });
		expect(await h.inspect.content.list("posts")).toHaveLength(1);
	});
});
