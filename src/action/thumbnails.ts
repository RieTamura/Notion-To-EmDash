/**
 * --thumbnails: draws the automatic thumbnail for posts that have no featured
 * image. Used next to the Notion To EmDash plugin, which sends the posts but
 * cannot draw (drawing needs more CPU than a plugin run has). Notion is not
 * read, so no Notion settings are needed.
 */

import { type Draw, makeAutoThumbnail } from "./auto-thumbnail.ts";
import type { ApiLike, EmDashApi } from "./emdash.ts";
import { toFeaturedImage } from "./media.ts";
import { COLLECTION } from "./publish.ts";

export interface PostSummary {
	id: string;
	slug: string | null;
	status: string;
	title: string;
}

interface ListedPost {
	id: string;
	slug: string | null;
	status: string;
	data: { title?: unknown; featured_image?: unknown };
}

interface ItemResponse {
	item: ListedPost & { liveRevisionId?: string | null; draftRevisionId?: string | null };
	_rev: string;
}

/** Pages of the posts list read at most, 100 posts each. */
const MAX_LIST_PAGES = 10;

/** Posts with a title and no featured image, except those whose slug starts with one of `skip`. */
export async function postsWithoutImage(api: ApiLike, skip: string[]): Promise<PostSummary[]> {
	const found: PostSummary[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const query = new URLSearchParams({ limit: "100" });
		if (cursor) query.set("cursor", cursor);
		const data = await api.request<{ items: ListedPost[]; nextCursor?: string | null }>("GET", `/content/${COLLECTION}?${query}`);
		for (const post of data.items) {
			const title = typeof post.data.title === "string" ? post.data.title.trim() : "";
			if (!title || post.data.featured_image) continue;
			if (skip.some((prefix) => post.slug?.startsWith(prefix))) continue;
			found.push({ id: post.id, slug: post.slug, status: post.status, title });
		}
		if (!data.nextCursor) break;
		cursor = data.nextCursor;
	}
	return found;
}

export type FillOutcome =
	| { kind: "made"; published: boolean }
	/** A featured image was set meanwhile, in the admin or by another run. */
	| { kind: "kept" }
	/** The site does not have the Auto Thumbnail Design plugin. */
	| { kind: "no-plugin" }
	/**
	 * The post is published and has unpublished changes. Publishing the
	 * thumbnail would publish those changes too, so the post is left alone.
	 */
	| { kind: "pending-changes" };

/**
 * Draws the thumbnail and sets it as the post's featured image. A published
 * post is published again, so the thumbnail shows on the site.
 */
export async function fillThumbnail(api: EmDashApi, post: PostSummary, draw?: Draw, now?: Date): Promise<FillOutcome> {
	const path = `/content/${COLLECTION}/${encodeURIComponent(post.id)}`;
	const current = await api.request<ItemResponse>("GET", path);
	const { item } = current;
	if (item.data.featured_image) return { kind: "kept" };
	const published = item.status === "published";
	if (published && item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId) {
		return { kind: "pending-changes" };
	}

	const outcome = await makeAutoThumbnail(api, post.title, post.id, draw, now);
	if (outcome.kind !== "made") return outcome;

	// _rev refuses the write if someone changed the post while the thumbnail was drawn.
	const saved = await api.request<ItemResponse>("PUT", path, {
		data: { featured_image: toFeaturedImage(outcome.media, post.title) },
		_rev: current._rev,
	});
	if (published) {
		await api.request("POST", `${path}/publish`, { _rev: saved._rev });
	}
	return { kind: "made", published };
}
