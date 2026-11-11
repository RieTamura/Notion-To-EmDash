import { describe, expect, it } from "vitest";
import { convertBlocks, type NotionBlock } from "../src/convert.ts";
import { EmDashApi, EmDashError, type FetchLike } from "../src/emdash.ts";
import { downloadImage, fileNameFromUrl, ImageDownloadError } from "../src/media.ts";
import type { Article } from "../src/notion.ts";
import type { ImageBlock } from "../src/portable-text.ts";
import { findPostId, PostNotFoundError, sendPost } from "../src/publish.ts";
import { sendArticle } from "../src/send.ts";
import { resolveTaxonomies, UnknownCategoryError } from "../src/taxonomy.ts";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ok(data: unknown): Response {
	return json({ success: true, data });
}

interface Call {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}

/** A fake server: each handler answers the first request whose "METHOD path" starts with its key. */
function fakeServer(routes: [string, (call: Call) => Response][]): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
			const call: Call = { url, method, body, headers: (init?.headers ?? {}) as Record<string, string> };
			calls.push(call);
			const path = url.replace("https://site.example/_emdash/api", "");
			const route = routes.find(([key]) => `${method} ${path}`.startsWith(key) || `${method} ${url}`.startsWith(key));
			if (!route) throw new Error(`Unexpected request: ${method} ${url}`);
			return route[1](call);
		},
	};
}

function api(fetch: FetchLike): EmDashApi {
	return new EmDashApi({ siteUrl: "https://site.example", token: "ec_pat_x", fetch });
}

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });

function media(id: string) {
	return { id, filename: `${id}.png`, mimeType: "image/png", width: 800, height: 600, storageKey: `${id}.png`, url: `/_emdash/api/media/file/${id}`, blurhash: "LEHV6n", dominantColor: "#112233" };
}

function article(overrides: Partial<Article> = {}): Article {
	return {
		pageId: "p1",
		notionUrl: "https://app.notion.com/p/1",
		lastEditedTime: "2026-11-10T00:00:00.000Z",
		lastEditedBy: "user",
		title: "テスト1",
		slug: "",
		excerpt: "",
		category: null,
		tags: [],
		featuredImage: null,
		emdashUrl: "",
		sentAt: null,
		...overrides,
	};
}

const created = (id = "post1", slug = "test-1") => ok({ item: { id, slug, status: "draft" }, _rev: "r1" });

describe("EmDashApi", () => {
	it("sends the token and unwraps the data", async () => {
		const { fetch, calls } = fakeServer([["GET /content/posts", () => ok({ items: [] })]]);
		await api(fetch).checkConnection();
		expect(calls[0]!.url).toBe("https://site.example/_emdash/api/content/posts?limit=1");
		expect(calls[0]!.headers.Authorization).toBe("Bearer ec_pat_x");
	});

	it("turns an EmDash error into EmDashError with its code", async () => {
		const { fetch } = fakeServer([
			["GET", () => json({ success: false, error: { code: "INSUFFICIENT_SCOPE", message: "Token lacks content:read" } }, 403)],
		]);
		const error = await api(fetch).checkConnection().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EmDashError);
		expect(error).toMatchObject({ status: 403, code: "INSUFFICIENT_SCOPE", message: "Token lacks content:read" });
	});

	it("says when the site is not EmDash", async () => {
		const { fetch } = fakeServer([["GET", () => new Response("<html>", { status: 200 })]]);
		await expect(api(fetch).checkConnection()).rejects.toMatchObject({ code: "NOT_EMDASH" });
	});

	it("uploads an image as multipart with deduplicate", async () => {
		const { fetch, calls } = fakeServer([["POST /media", () => ok({ item: media("m1") })]]);
		const item = await api(fetch).uploadImage({ name: "a.png", data: new Uint8Array([1, 2]), type: "image/png" });
		expect(item.id).toBe("m1");
		const form = calls[0]!.body as FormData;
		expect(form.get("deduplicate")).toBe("true");
		expect((form.get("file") as File).name).toBe("a.png");
		expect((form.get("file") as File).type).toBe("image/png");
	});
});

describe("downloadImage", () => {
	it("takes the name from the URL and the type from the response", async () => {
		const file = await downloadImage("https://s3.example/x/%E5%86%99%E7%9C%9F.png?X-Amz-Signature=secret", async () => png());
		expect(file).toMatchObject({ name: "写真.png", type: "image/png" });
		expect(file.data.byteLength).toBe(4);
	});

	it("adds an extension when the URL has none", async () => {
		const file = await downloadImage("https://images.example/photo", async () =>
			new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg" } }));
		expect(file.name).toBe("photo.jpg");
	});

	it("refuses something that is not an image, without showing the signed query", async () => {
		const error = await downloadImage("https://s3.example/page?X-Amz-Signature=secret", async () =>
			new Response("<html>", { headers: { "Content-Type": "text/html" } })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ImageDownloadError);
		expect((error as Error).message).not.toContain("secret");
	});

	it("reports a failed download", async () => {
		await expect(downloadImage("https://s3.example/a.png", async () => new Response("", { status: 403 })))
			.rejects.toThrow("HTTP 403");
	});

	it("reads names from URLs", () => {
		expect(fileNameFromUrl("https://a.example/b/c%20d.png?x=1")).toBe("c d.png");
		expect(fileNameFromUrl("not a url")).toBe("");
	});
});

describe("resolveTaxonomies", () => {
	it("finds the category by label or slug and creates missing tags once", async () => {
		const { fetch, calls } = fakeServer([
			["GET /taxonomies/category/terms", () => ok({ terms: [{ slug: "tech", label: "技術", children: [{ slug: "web", label: "Web" }] }] })],
			["GET /taxonomies/tag/terms", () => ok({ terms: [{ slug: "notion", label: "Notion" }] })],
			["POST /taxonomies/tag/terms", (call) => ok({ term: { slug: "new-tag", label: (call.body as { label: string }).label } })],
		]);
		const result = await resolveTaxonomies(api(fetch), "web", ["notion", "新しいタグ", "新しいタグ"]);
		expect(result).toEqual({ category: ["web"], tag: ["notion", "new-tag"] });
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});

	it("does not create categories", async () => {
		const { fetch } = fakeServer([["GET /taxonomies/category/terms", () => ok({ terms: [{ slug: "tech", label: "技術" }] })]]);
		await expect(resolveTaxonomies(api(fetch), "日記", [])).rejects.toBeInstanceOf(UnknownCategoryError);
	});

	it("sends nothing for an empty category and no tags", async () => {
		const { fetch, calls } = fakeServer([]);
		expect(await resolveTaxonomies(api(fetch), null, [])).toEqual({});
		expect(calls).toHaveLength(0);
	});
});

describe("sendPost", () => {
	it("creates a draft", async () => {
		const { fetch, calls } = fakeServer([["POST /content/posts", () => created()]]);
		const result = await sendPost(api(fetch), { title: "T", content: [], publish: false });
		expect(result).toEqual({ id: "post1", slug: "test-1", created: true, published: false });
		expect(calls[0]!.body).toEqual({ data: { title: "T", content: [] }, status: "draft" });
	});

	it("updates by ID without a revision check, and publishes when asked", async () => {
		const { fetch, calls } = fakeServer([
			["PUT /content/posts/post1", () => ok({ item: { id: "post1", slug: "s", status: "published" }, _rev: "r2" })],
			["POST /content/posts/post1/publish", () => ok({ item: { id: "post1", slug: "s", status: "published" }, _rev: "r3" })],
		]);
		await sendPost(api(fetch), { id: "post1", title: "T", slug: "s", excerpt: "E", content: [], taxonomies: { tag: ["a"] }, publish: true });
		expect(calls[0]!.body).toEqual({ data: { title: "T", content: [], excerpt: "E" }, slug: "s", taxonomies: { tag: ["a"] } });
		expect(calls[1]!.body).toEqual({ _rev: "r2" });
	});
});

describe("sendArticle", () => {
	const imageBlock = (url: string): NotionBlock => ({ id: url, type: "image", image: { type: "file", file: { url }, caption: [] } });

	it("uploads body images and the featured image, then creates the post", async () => {
		let n = 0;
		const { fetch, calls } = fakeServer([
			["GET https://files.example/", () => png()],
			["POST /media", () => ok({ item: media(`m${++n}`) })],
			["POST /content/posts", () => created()],
		]);
		const body = convertBlocks([
			imageBlock("https://files.example/a.png?sig=1"),
			imageBlock("https://files.example/a.png?sig=1"),
		]);
		const result = await sendArticle(api(fetch), article({
			featuredImage: { url: "https://files.example/cover.png?sig=2", name: "cover.png", expires: true },
		}), body, { publish: false, fetch });

		expect(result.url).toBe("https://site.example/posts/test-1");
		// The same image is read and uploaded once
		expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/media"))).toHaveLength(2);
		const image = body.blocks[0] as ImageBlock;
		expect(image.asset).toEqual({ _ref: "m1", url: "/_emdash/api/media/file/m1", provider: "local" });
		expect(image).toMatchObject({ width: 800, height: 600, blurhash: "LEHV6n" });
		const post = calls.at(-1)!.body as { data: Record<string, unknown>; status: string };
		expect(post.status).toBe("draft");
		expect(post.data.featured_image).toMatchObject({ provider: "local", id: "m2", alt: "テスト1", meta: { storageKey: "m2.png" } });
	});

	it("does not create the post when an image cannot be read", async () => {
		const { fetch, calls } = fakeServer([["GET https://files.example/", () => new Response("", { status: 403 })]]);
		const body = convertBlocks([imageBlock("https://files.example/a.png?sig=1")]);
		await expect(sendArticle(api(fetch), article(), body, { publish: false, fetch })).rejects.toBeInstanceOf(ImageDownloadError);
		expect(calls.some((c) => c.url.includes("/content/"))).toBe(false);
	});
});

describe("findPostId", () => {
	it("finds the post by the slug at the end of the URL, Japanese or not", async () => {
		const { fetch, calls } = fakeServer([["GET /content/posts/", () => ok({ item: { id: "post1" } })]]);
		expect(await findPostId(api(fetch), "https://site.example", "https://site.example/posts/テスト1")).toBe("post1");
		expect(await findPostId(api(fetch), "https://site.example", "https://site.example/posts/%E3%83%86/")).toBe("post1");
		expect(calls[0]!.url).toBe("https://site.example/_emdash/api/content/posts/%E3%83%86%E3%82%B9%E3%83%881");
		expect(calls[1]!.url).toBe("https://site.example/_emdash/api/content/posts/%E3%83%86");
	});

	it("says what to do when the post is gone", async () => {
		const { fetch } = fakeServer([["GET", () => json({ success: false, error: { code: "NOT_FOUND", message: "Content item not found" } }, 404)]]);
		const error = await findPostId(api(fetch), "https://site.example", "https://site.example/posts/a").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PostNotFoundError);
		expect((error as Error).message).toContain("empty it");
	});

	it("refuses a URL on another site or no URL at all, without asking the site", async () => {
		const { fetch, calls } = fakeServer([]);
		await expect(findPostId(api(fetch), "https://site.example", "https://other.example/posts/a")).rejects.toBeInstanceOf(PostNotFoundError);
		await expect(findPostId(api(fetch), "https://site.example", "テスト")).rejects.toBeInstanceOf(PostNotFoundError);
		expect(calls).toHaveLength(0);
	});

	it("passes other errors through", async () => {
		const { fetch } = fakeServer([["GET", () => json({ success: false, error: { code: "INVALID_TOKEN", message: "x" } }, 401)]]);
		await expect(findPostId(api(fetch), "https://site.example", "https://site.example/posts/a")).rejects.toBeInstanceOf(EmDashError);
	});
});

describe("sendArticle with an existing post", () => {
	it("updates the post and publishes it when asked", async () => {
		const { fetch, calls } = fakeServer([
			["PUT /content/posts/post1", () => ok({ item: { id: "post1", slug: "a", status: "draft" }, _rev: "r2" })],
			["POST /content/posts/post1/publish", () => ok({ item: { id: "post1", slug: "a", status: "published" }, _rev: "r3" })],
		]);
		const result = await sendArticle(api(fetch), article(), convertBlocks([]), { postId: "post1", publish: true, fetch });
		expect(result).toMatchObject({ created: false, published: true, url: "https://site.example/posts/a" });
		expect(calls.map((c) => c.method)).toEqual(["PUT", "POST"]);
	});
});

describe("featured image and automatic thumbnail", () => {
	const imageBlock = (url: string): NotionBlock => ({ id: url, type: "image", image: { type: "file", file: { url }, caption: [{ plain_text: "写真", annotations: {}, href: null, type: "text", text: { content: "写真", link: null } }] } });
	const design = { width: 1200, height: 630, background: { color: "#ffffff", image: null, overlay: false }, textColor: "#000000", font: "Zen Maru Gothic", siteName: "Site", logo: null };
	const drawn: { title: string; date: string; siteUrl: string }[] = [];
	const draw = async (_d: unknown, text: { title: string; date: string }, siteUrl: string) => {
		drawn.push({ ...text, siteUrl });
		return new Uint8Array([137, 80, 78, 71]);
	};
	const postData = (featured: unknown, publishedAt: string | null = null) =>
		ok({ item: { id: "post1", slug: "a", status: "published", publishedAt, data: { featured_image: featured } }, _rev: "r1" });
	const updated = () => ok({ item: { id: "post1", slug: "a", status: "draft" }, _rev: "r2" });
	const lastBody = (calls: Call[]) => calls.at(-1)!.body as { data: Record<string, unknown> };

	it("uses the first body image when Notion has no featured image, without drawing", async () => {
		drawn.length = 0;
		const { fetch, calls } = fakeServer([
			["GET https://files.example/", () => png()],
			["POST /media", () => ok({ item: media("m1") })],
			["POST /content/posts", () => created()],
		]);
		const result = await sendArticle(api(fetch), article(), convertBlocks([imageBlock("https://files.example/a.png")]), { publish: false, fetch, thumbnail: { draw } });
		expect(lastBody(calls).data.featured_image).toMatchObject({ id: "m1", alt: "写真" });
		expect(drawn).toHaveLength(0);
		expect(result.thumbnail).toBeUndefined();
	});

	it("draws and uploads a thumbnail for a new post with no image", async () => {
		drawn.length = 0;
		const { fetch, calls } = fakeServer([
			["GET /plugins/auto-thumbnail/design", () => ok(design)],
			["POST /media", () => ok({ item: { ...media("t1"), filename: "auto-thumbnail-20261111.png" } })],
			["POST /content/posts", () => created()],
		]);
		const result = await sendArticle(api(fetch), article(), convertBlocks([]), { publish: false, fetch, thumbnail: { draw } });
		expect(drawn).toEqual([{ title: "テスト1", date: expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/), siteUrl: "https://site.example" }]);
		const upload = calls.find((c) => c.url.endsWith("/media"))!.body as FormData;
		expect((upload.get("file") as File).name).toMatch(/^auto-thumbnail-\d{8}\.png$/);
		expect(lastBody(calls).data.featured_image).toMatchObject({ id: "t1", alt: "テスト1" });
		expect(result.thumbnail).toBe("made a thumbnail");
	});

	it("keeps a featured image chosen in the admin when updating", async () => {
		drawn.length = 0;
		const { fetch, calls } = fakeServer([
			["GET /content/posts/post1", () => postData({ id: "x", filename: "photo.jpg" })],
			["PUT /content/posts/post1", () => updated()],
		]);
		const result = await sendArticle(api(fetch), article(), convertBlocks([]), { postId: "post1", publish: false, fetch, thumbnail: { draw } });
		expect(drawn).toHaveLength(0);
		expect(lastBody(calls).data.featured_image).toBeUndefined();
		expect(result.thumbnail).toContain("kept");
	});

	it("redraws an earlier automatic thumbnail with the post's published date", async () => {
		drawn.length = 0;
		const { fetch, calls } = fakeServer([
			["GET /content/posts/post1", () => postData({ id: "t0", filename: "auto-thumbnail-20261101.png" }, "2026-11-01T03:00:00.000Z")],
			["GET /plugins/auto-thumbnail/design", () => ok(design)],
			["POST /media", () => ok({ item: media("t1") })],
			["PUT /content/posts/post1", () => updated()],
		]);
		await sendArticle(api(fetch), article(), convertBlocks([]), { postId: "post1", publish: false, fetch, thumbnail: { draw } });
		expect(drawn[0]!.date).toBe("2026.11.01");
		expect(lastBody(calls).data.featured_image).toMatchObject({ id: "t1" });
	});

	it("sends without a thumbnail when the site has no plugin, or drawing fails", async () => {
		const { fetch } = fakeServer([
			["GET /plugins/auto-thumbnail/design", () => json({ success: false, error: { code: "NOT_FOUND", message: "x" } }, 404)],
			["POST /content/posts", () => created()],
		]);
		const none = await sendArticle(api(fetch), article(), convertBlocks([]), { publish: false, fetch, thumbnail: { draw } });
		expect(none.thumbnail).toContain("does not have");

		const broken = fakeServer([
			["GET /plugins/auto-thumbnail/design", () => ok(design)],
			["POST /content/posts", () => created()],
		]);
		const failing = async () => { throw new Error("canvas broke"); };
		const result = await sendArticle(api(broken.fetch), article(), convertBlocks([]), { publish: false, fetch: broken.fetch, thumbnail: { draw: failing } });
		expect(result.thumbnail).toContain("canvas broke");
		expect(lastBody(broken.calls).data.featured_image).toBeUndefined();
	});

	it("does not draw when the setting is off", async () => {
		const { fetch, calls } = fakeServer([["POST /content/posts", () => created()]]);
		await sendArticle(api(fetch), article(), convertBlocks([]), { publish: false, fetch });
		expect(calls).toHaveLength(1);
	});
});
