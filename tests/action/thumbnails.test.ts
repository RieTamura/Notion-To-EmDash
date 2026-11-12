import { describe, expect, it } from "vitest";
import { loadThumbnailConfig } from "../../src/action/config.ts";
import { EmDashApi, type FetchLike } from "../../src/action/emdash.ts";
import { fillThumbnail, postsWithoutImage } from "../../src/action/thumbnails.ts";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ok = (data: unknown) => json({ success: true, data });

interface Call {
	method: string;
	path: string;
	body: unknown;
}

/** A fake EmDash: each handler answers the requests whose "METHOD path" starts with its key. */
function fakeServer(routes: [string, (call: Call) => Response][]) {
	const calls: Call[] = [];
	const fetch: FetchLike = async (url, init) => {
		const method = init?.method ?? "GET";
		const path = url.replace("https://site.example/_emdash/api", "");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
		const call = { method, path, body };
		calls.push(call);
		const route = routes.find(([key]) => `${method} ${path}`.startsWith(key));
		if (!route) throw new Error(`Unexpected request: ${method} ${path}`);
		return route[1](call);
	};
	return { api: new EmDashApi({ siteUrl: "https://site.example", token: "ec_pat_x", fetch }), calls };
}

const design = { width: 1200, height: 630, background: { color: "#ffffff", image: null, overlay: false }, textColor: "#000000", font: "Noto Sans JP", siteName: "Site", logo: null };
const draw = async () => new Uint8Array([137, 80, 78, 71]);
const thumbnailMedia = { id: "t1", filename: "auto-thumbnail-20261112.png", mimeType: "image/png", width: 1200, height: 630, storageKey: "t1.png", url: "/_emdash/api/media/file/t1" };

function post(id: string, slug: string, data: Record<string, unknown>, status = "published") {
	return { id, slug, status, data };
}

describe("finding posts without a featured image", () => {
	it("lists titled posts with no featured image, skipping the given slug beginnings", async () => {
		const { api } = fakeServer([
			[
				"GET /content/posts?",
				() =>
					ok({
						items: [
							post("1", "notion-post", { title: "Notion から" }),
							post("2", "with-image", { title: "画像あり", featured_image: { id: "m" } }),
							post("3", "weekly-2026-11-14", { title: "週刊まとめ" }),
							post("4", "untitled", { title: "  " }),
							post("5", "draft-post", { title: "下書き" }, "draft"),
						],
					}),
			],
		]);

		const posts = await postsWithoutImage(api, ["weekly-"]);
		expect(posts.map((p) => p.id)).toEqual(["1", "5"]);
	});

	it("follows the next page", async () => {
		const { api, calls } = fakeServer([
			["GET /content/posts?limit=100&cursor=c2", () => ok({ items: [post("2", "b", { title: "二" })] })],
			["GET /content/posts?limit=100", () => ok({ items: [post("1", "a", { title: "一" })], nextCursor: "c2" })],
		]);
		expect((await postsWithoutImage(api, [])).map((p) => p.id)).toEqual(["1", "2"]);
		expect(calls).toHaveLength(2);
	});
});

describe("drawing the thumbnail", () => {
	const item = (extra: Record<string, unknown> = {}) =>
		ok({ item: { id: "1", slug: "a", status: "published", publishedAt: "2026-11-12T00:00:00.000Z", liveRevisionId: "r-live", draftRevisionId: null, data: { title: "記事" }, ...extra }, _rev: "rev1" });

	it("sets it as the featured image and publishes a published post again", async () => {
		const { api, calls } = fakeServer([
			["GET /content/posts/1", () => item()],
			["GET /plugins/auto-thumbnail/design", () => ok(design)],
			["POST /media", () => ok({ item: thumbnailMedia })],
			["PUT /content/posts/1", () => ok({ item: { id: "1" }, _rev: "rev2" })],
			["POST /content/posts/1/publish", () => ok({ item: { id: "1" }, _rev: "rev3" })],
		]);

		expect(await fillThumbnail(api, { id: "1", slug: "a", status: "published", title: "記事" }, draw)).toEqual({ kind: "made", published: true });

		const put = calls.find((c) => c.method === "PUT")!;
		expect(put.body).toMatchObject({ _rev: "rev1", data: { featured_image: { id: "t1", alt: "記事", filename: "auto-thumbnail-20261112.png" } } });
		// Only the featured image is sent, so nothing else in the post changes.
		expect(Object.keys((put.body as { data: object }).data)).toEqual(["featured_image"]);
		expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/content/posts/1/publish", body: { _rev: "rev2" } });
	});

	it("does not publish a draft", async () => {
		const { api, calls } = fakeServer([
			["GET /content/posts/1", () => item({ status: "draft", liveRevisionId: null, draftRevisionId: "r-draft", publishedAt: null })],
			["GET /plugins/auto-thumbnail/design", () => ok(design)],
			["POST /media", () => ok({ item: thumbnailMedia })],
			["PUT /content/posts/1", () => ok({ item: { id: "1" }, _rev: "rev2" })],
		]);
		expect(await fillThumbnail(api, { id: "1", slug: "a", status: "draft", title: "記事" }, draw)).toEqual({ kind: "made", published: false });
		expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
	});

	it("leaves a published post with unpublished changes alone", async () => {
		const { api, calls } = fakeServer([["GET /content/posts/1", () => item({ draftRevisionId: "r-draft" })]]);
		expect(await fillThumbnail(api, { id: "1", slug: "a", status: "published", title: "記事" }, draw)).toEqual({ kind: "pending-changes" });
		expect(calls).toHaveLength(1);
	});

	it("says so when the site has no Auto Thumbnail Design plugin", async () => {
		const { api } = fakeServer([
			["GET /content/posts/1", () => item()],
			["GET /plugins/auto-thumbnail/design", () => json({ success: false, error: { code: "NOT_FOUND", message: "x" } }, 404)],
		]);
		expect(await fillThumbnail(api, { id: "1", slug: "a", status: "published", title: "記事" }, draw)).toEqual({ kind: "no-plugin" });
	});
});

describe("thumbnail settings", () => {
	it("need only the EmDash address and token", () => {
		expect(loadThumbnailConfig({ EMDASH_URL: "https://site.example/", EMDASH_TOKEN: "t", THUMBNAIL_SKIP: "weekly-, renewal" })).toEqual({
			emdashUrl: "https://site.example",
			emdashToken: "t",
			maxPosts: 5,
			skip: ["weekly-", "renewal"],
		});
		expect(() => loadThumbnailConfig({ EMDASH_URL: "https://site.example" })).toThrow("EMDASH_TOKEN");
	});
});
