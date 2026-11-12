/** Creates or updates a post. Ported from Post To EmDash's publish.ts. */

import type { ApiLike } from "./emdash.ts";
import type { FeaturedImageValue } from "./media.ts";
import type { Block } from "../shared/portable-text.ts";

export interface PostInput {
	/** The post's ID from an earlier send. Without it, a new post is made. */
	id?: string;
	title: string;
	/** When empty, EmDash makes one from the title for a new post, and an update keeps the old one. */
	slug?: string;
	excerpt?: string;
	content: Block[];
	/** When undefined, the site's featured image is left as it is. */
	featuredImage?: FeaturedImageValue;
	/** { category: [slug], tag: [slug…] }, only the ones set in Notion. */
	taxonomies?: Record<string, string[]>;
	publish: boolean;
}

export interface PostResult {
	id: string;
	slug: string;
	created: boolean;
	/** False means a draft (an update to a published post leaves the live version as it is). */
	published: boolean;
}

interface ItemResponse {
	item: { id: string; slug: string; status: string; liveRevisionId?: string | null };
	_rev: string;
}

export const COLLECTION = "posts";

/**
 * Notion is where the article is written, so an update always replaces the site's version
 * (no _rev check). Edits made in the EmDash admin are overwritten by the next send.
 */
export async function sendPost(api: ApiLike, input: PostInput): Promise<PostResult> {
	const data: Record<string, unknown> = { title: input.title, content: input.content };
	if (input.excerpt) data.excerpt = input.excerpt;
	if (input.featuredImage) data.featured_image = input.featuredImage;
	const taxonomies = input.taxonomies && Object.keys(input.taxonomies).length ? input.taxonomies : undefined;

	const body: Record<string, unknown> = { data };
	if (input.slug) body.slug = input.slug;
	if (taxonomies) body.taxonomies = taxonomies;

	let response: ItemResponse;
	const created = !input.id;
	if (input.id) {
		response = await api.request<ItemResponse>("PUT", `/content/${COLLECTION}/${encodeURIComponent(input.id)}`, body);
	} else {
		response = await api.request<ItemResponse>("POST", `/content/${COLLECTION}`, { ...body, status: "draft" });
	}

	if (input.publish) {
		response = await api.request<ItemResponse>(
			"POST",
			`/content/${COLLECTION}/${encodeURIComponent(response.item.id)}/publish`,
			{ _rev: response._rev },
		);
	}

	return { id: response.item.id, slug: response.item.slug, created, published: input.publish };
}

/** The post's page URL. */
export function postUrl(siteUrl: string, slug: string): string {
	return `${siteUrl}/${COLLECTION}/${slug}`;
}

/** The post a page was sent to can no longer be found on the site. */
export class PostNotFoundError extends Error {
	override name = "PostNotFoundError";
}

/**
 * The ID of the post a page was sent to, found from the EmDash URL written back to Notion.
 * The API takes a slug in place of an ID, so the URL's last part is enough.
 * Throws PostNotFoundError when the URL is for another site or the post is gone.
 */
export async function findPostId(api: ApiLike, siteUrl: string, emdashUrl: string): Promise<string> {
	let url: URL;
	try {
		url = new URL(emdashUrl);
	} catch {
		throw new PostNotFoundError(`"${emdashUrl}" in Notion is not a URL. Empty it to send the page as a new post`);
	}
	if (url.origin !== new URL(siteUrl).origin) {
		throw new PostNotFoundError(`${emdashUrl} is not on ${siteUrl}. Empty the EmDash URL in Notion to send the page as a new post`);
	}
	const last = url.pathname.split("/").filter(Boolean).pop();
	if (!last) throw new PostNotFoundError(`${emdashUrl} has no post slug. Empty it to send the page as a new post`);
	let slug: string;
	try {
		slug = decodeURIComponent(last);
	} catch {
		slug = last;
	}
	try {
		const data = await api.request<{ item: { id: string } }>("GET", `/content/${COLLECTION}/${encodeURIComponent(slug)}`);
		return data.item.id;
	} catch (error) {
		if ((error as { status?: number }).status === 404) {
			throw new PostNotFoundError(
				`The post ${emdashUrl} is not on the site (deleted, or its slug was changed in the admin). ` +
				"Put its current URL in the EmDash URL in Notion, or empty it to send the page as a new post",
			);
		}
		throw error;
	}
}
