import { afterEach, describe, expect, it } from "vitest";

import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import { RUN_BUDGET } from "../../src/plugin/budget.ts";
import {
	block,
	CONFIGURED,
	createSite,
	FILES,
	image,
	page,
	paragraph,
	png,
	respondChildren,
	respondDatabase,
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

async function termSlugs(h: PluginRuntimeTestHost, id: string, taxonomy: string) {
	return (await h.inspect.content.terms("posts", id, taxonomy)).map((term) => term.slug).sort();
}

describe("sending a page", () => {
	it("makes and publishes a post with its images, category and tags, within the call budget", async () => {
		const h = (host = await createSite(CONFIGURED));
		await h.fixtures.taxonomy({ name: "category", slug: "news", label: "お知らせ" });
		await h.fixtures.taxonomy({ name: "tag", slug: "notion", label: "Notion" });
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "はじめての記事", { excerpt: "抜粋です", category: "お知らせ", tags: ["Notion", "新しいタグ"] })]);
		await respondChildren(h, PAGE_ID, [
			block("h", "heading_1", { rich_text: [{ type: "text", plain_text: "見出し", text: { content: "見出し" }, annotations: {} }] }),
			image("i1", `${FILES}/a.png?sig=1`),
			image("i2", "https://example.org/photo.jpg", "external"),
			paragraph("p", "本文"),
		]);
		await h.http.respond(`${FILES}/a.png?sig=1`, png());

		const runs = await syncUntilDone(h);

		const sent = runs.at(-1)!;
		expect(sent).toMatchObject({ status: "sent", title: "はじめての記事", created: true, published: true });
		expect(sent.images).toEqual({ uploaded: 1, links: 1, dropped: [] });
		for (const run of runs) expect(run.calls).toBeLessThanOrEqual(RUN_BUDGET);

		const posts = await h.inspect.content.list("posts");
		expect(posts).toHaveLength(1);
		const post = posts[0]!;
		expect(post.status).toBe("published");
		expect(post.data.title).toBe("はじめての記事");
		expect(post.data.excerpt).toBe("抜粋です");

		const content = post.data.content as Array<{ _type: string; asset?: { _ref?: string; url?: string } }>;
		const images = content.filter((b) => b._type === "image");
		expect(images[0]?.asset?._ref).toBeTruthy();
		expect(images[1]?.asset).toEqual({ url: "https://example.org/photo.jpg" });
		expect(post.data.featured_image).toMatchObject({ provider: "local", id: images[0]?.asset?._ref, alt: "はじめての記事" });

		expect(await termSlugs(h, post.id, "category")).toEqual(["news"]);
		expect((await h.inspect.content.terms("posts", post.id, "tag")).map((t) => t.label).sort()).toEqual(["Notion", "新しいタグ"]);

		expect(await h.inspect.storage.get("pages", PAGE_ID)).toMatchObject({ contentId: post.id });
		expect(await h.inspect.kv.get("state:job")).toBeNull();
	});

	it("leaves the post as a draft when the settings say so", async () => {
		const h = (host = await createSite({ ...CONFIGURED, mode: "draft" }));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "下書きの記事")]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);

		const runs = await syncUntilDone(h);

		expect(runs.at(-1)).toMatchObject({ status: "sent", published: false });
		expect((await h.inspect.content.list("posts"))[0]?.status).toBe("draft");
	});

	it("updates the same post when the page is edited again", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "最初の題", { tags: ["古いタグ"] })]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "一回目")]);
		await syncUntilDone(h);

		await respondPages(h, [page(PAGE_ID, "直した題", { tags: ["新しいタグ"], edited: "2026-11-12T02:00:00.000Z" })]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "二回目")]);
		const runs = await syncUntilDone(h);

		expect(runs.at(-1)).toMatchObject({ status: "sent", created: false });
		const posts = await h.inspect.content.list("posts");
		expect(posts).toHaveLength(1);
		expect(posts[0]?.data.title).toBe("直した題");
		expect((await h.inspect.content.terms("posts", posts[0]!.id, "tag")).map((t) => t.label)).toEqual(["新しいタグ"]);
	});

	it("updates the post a page was sent to by the GitHub Actions tool", async () => {
		const h = (host = await createSite(CONFIGURED));
		const existing = await h.fixtures.content("posts", { slug: "from-actions", data: { title: "前の題" } } as never);
		await respondDatabase(h);
		await respondPages(h, [
			page(PAGE_ID, "Actions で送った記事", { emdashUrl: `${SITE}/posts/from-actions`, sentAt: "2026-11-11T00:00:00.000Z" }),
		]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);

		const runs = await syncUntilDone(h);

		expect(runs.at(-1)).toMatchObject({ status: "sent", created: false, contentId: existing.id });
		expect(await h.inspect.content.list("posts")).toHaveLength(1);
	});

	it("does not send a page whose EmDash URL is on another site", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "別のサイト", { emdashUrl: "https://other.example/posts/x", sentAt: "2026-11-11T00:00:00.000Z" })]);

		const result = await sync(h);

		expect(result).toMatchObject({ status: "failed", pageId: PAGE_ID });
		expect(String(result.reason)).toContain("is not on");
		expect(await h.inspect.content.list("posts")).toHaveLength(0);
	});
});

describe("pages that cannot be sent", () => {
	it("skips a page with an unknown category until it is edited, and sends the next page", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		const broken = page(PAGE_ID, "カテゴリが違う", { category: "ない" });
		await respondPages(h, [broken, page("page-2", "次の記事")]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);

		const first = await syncUntilDone(h);
		expect(first.at(-1)).toMatchObject({ status: "failed", pageId: PAGE_ID });
		expect(String(first.at(-1)!.reason)).toContain("ない");
		expect(await h.inspect.storage.get("pages", PAGE_ID)).toMatchObject({ failedEdit: broken.last_edited_time });

		await respondPages(h, [broken, page("page-2", "次の記事")]);
		await respondChildren(h, "page-2", [paragraph("p", "本文")]);
		const second = await syncUntilDone(h);
		expect(second.at(-1)).toMatchObject({ status: "sent", pageId: "page-2" });
	});

	it("leaves out an image Notion no longer serves, and still sends the post", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "画像が切れた記事")]);
		await respondChildren(h, PAGE_ID, [image("i1", `${FILES}/gone.png?sig=1`), paragraph("p", "本文")]);
		await h.http.respond(`${FILES}/gone.png?sig=1`, new Response("expired", { status: 403 }));

		const runs = await syncUntilDone(h);

		const sent = runs.at(-1)!;
		expect(sent).toMatchObject({ status: "sent" });
		expect((sent.images as { dropped: string[] }).dropped).toEqual([`${FILES}/gone.png: HTTP 403`]);
		const content = (await h.inspect.content.list("posts"))[0]!.data.content as Array<{ _type: string }>;
		expect(content.some((b) => b._type === "image")).toBe(false);
	});

	it("says so when the site has no posts collection", async () => {
		const h = (host = await createSite(CONFIGURED, { posts: false }));
		await respondDatabase(h);

		const result = await sync(h);
		expect(result).toMatchObject({ status: "schema_invalid" });
		expect(JSON.stringify(result)).toContain("posts");
	});
});

describe("spreading work over runs", () => {
	it("reads a long, deeply nested page over several runs without going over the budget", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "長い記事")]);
		// 30 blocks with children: one request each.
		const parents = Array.from({ length: 30 }, (_, i) => paragraph(`b${i}`, `段落 ${i}`, true));
		await respondChildren(h, PAGE_ID, parents);
		for (let i = 0; i < 30; i++) await respondChildren(h, `b${i}`, [paragraph(`c${i}`, `子 ${i}`)]);

		const runs = await syncUntilDone(h);

		expect(runs.length).toBeGreaterThan(1);
		expect(runs.slice(0, -1).every((run) => run.status === "working")).toBe(true);
		expect(runs.at(-1)).toMatchObject({ status: "sent" });
		for (const run of runs) expect(run.calls).toBeLessThanOrEqual(RUN_BUDGET);
		const text = JSON.stringify((await h.inspect.content.list("posts"))[0]!.data.content);
		expect(text).toContain("子 29");
	});

	it("does not ask Notion who it is again on later runs", async () => {
		const h = (host = await createSite(CONFIGURED));
		await respondDatabase(h);
		await respondPages(h, [page(PAGE_ID, "一つ目")]);
		await respondChildren(h, PAGE_ID, [paragraph("p", "本文")]);
		await syncUntilDone(h);
		h.http.clear();

		await respondPages(h, []);
		expect(await sync(h)).toMatchObject({ status: "nothing_to_send" });
		expect(h.http.requests().map((r) => new URL(r.url).pathname)).toEqual([`/v1/data_sources/source-1/query`]);
	});
});
