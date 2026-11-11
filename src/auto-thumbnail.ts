/**
 * The automatic thumbnail for an article with no featured image and no body image.
 * Same rules as Post To EmDash's makeAutoThumbnail: the site's Auto Thumbnail Design
 * plugin gives the design, and a featured image chosen in the admin is never replaced.
 */

import { type EmDashApi, EmDashError } from "./emdash.ts";
import type { MediaItem } from "./media.ts";
import { COLLECTION } from "./publish.ts";
import { drawThumbnail } from "./thumbnail-draw.ts";
import { DESIGN_PATH, formatDate, isAutoThumbnail, readDesign, THUMBNAIL_PREFIX } from "./thumbnail.ts";

export type Draw = typeof drawThumbnail;

export type ThumbnailOutcome =
	| { kind: "made"; media: MediaItem }
	/** The post has a featured image chosen in the admin. */
	| { kind: "kept" }
	/** The site does not have the Auto Thumbnail Design plugin. */
	| { kind: "no-plugin" };

/**
 * Draws and uploads the thumbnail. postId is the post being updated, if any:
 * its date is used, and its featured image is kept unless it is an earlier automatic one.
 * The date is in the time zone of the machine (set TZ, e.g. Asia/Tokyo, on GitHub Actions).
 */
export async function makeAutoThumbnail(
	api: Pick<EmDashApi, "siteUrl" | "request" | "uploadImage">,
	title: string,
	postId: string | undefined,
	draw: Draw = drawThumbnail,
	now: Date = new Date(),
): Promise<ThumbnailOutcome> {
	let date = now;
	if (postId) {
		const { item } = await api.request<{ item: { data: Record<string, unknown>; publishedAt?: string | null } }>(
			"GET",
			`/content/${COLLECTION}/${encodeURIComponent(postId)}`,
		);
		const current = item.data.featured_image as { filename?: unknown } | null | undefined;
		if (current && !isAutoThumbnail(current.filename)) return { kind: "kept" };
		if (item.publishedAt) date = new Date(item.publishedAt);
	}

	let raw: unknown;
	try {
		raw = await api.request<unknown>("GET", DESIGN_PATH);
	} catch (error) {
		if (error instanceof EmDashError && error.status === 404) return { kind: "no-plugin" };
		throw error;
	}

	const day = formatDate(date);
	const png = await draw(readDesign(raw), { title, date: day }, api.siteUrl);
	const media = await api.uploadImage({ name: `${THUMBNAIL_PREFIX}-${day.replace(/\./g, "")}.png`, data: png, type: "image/png" });
	return { kind: "made", media };
}

