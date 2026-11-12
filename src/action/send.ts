/** Sends one Notion article to EmDash: images first, then the post. */

import { type Draw, makeAutoThumbnail } from "./auto-thumbnail.ts";
import type { ConvertResult } from "../shared/convert.ts";
import type { EmDashApi, FetchLike } from "./emdash.ts";
import { downloadImage, type FeaturedImageValue, fillImageBlock, type MediaItem, toFeaturedImage } from "./media.ts";
import type { Article } from "../shared/notion.ts";
import { type PostResult, postUrl, sendPost } from "./publish.ts";
import { resolveTaxonomies } from "./taxonomy.ts";

export interface SendOptions {
	/** The post's ID from an earlier send; without it a new post is made. */
	postId?: string;
	publish: boolean;
	/** For reading images; tests replace it. */
	fetch?: FetchLike;
	/**
	 * Draw a thumbnail when there is no featured image and no body image.
	 * Undefined means no thumbnail; tests pass their own drawing function.
	 */
	thumbnail?: { draw?: Draw };
}

export interface SendResult extends PostResult {
	url: string;
	imagesUploaded: number;
	/** What happened about the automatic thumbnail, for the log. Undefined when it was not needed. */
	thumbnail?: string;
}

/** Uploads an image once per run, even when the article uses it twice. */
function uploader(api: EmDashApi, fetchFn: FetchLike | undefined) {
	const done = new Map<string, Promise<MediaItem>>();
	return (url: string): Promise<MediaItem> => {
		let pending = done.get(url);
		if (!pending) {
			pending = downloadImage(url, fetchFn).then((file) => api.uploadImage(file));
			done.set(url, pending);
		}
		return pending;
	};
}

export async function sendArticle(
	api: EmDashApi,
	article: Article,
	body: ConvertResult,
	options: SendOptions,
): Promise<SendResult> {
	const upload = uploader(api, options.fetch);

	// Body images, in order. Notion's links expire after an hour, so they are read now
	let firstImage: { media: MediaItem; alt: string } | undefined;
	for (const image of body.images) {
		const url = image.asset.url;
		if (!url) continue;
		const media = await upload(url);
		fillImageBlock(image, media);
		firstImage ??= { media, alt: image.alt };
	}

	// The featured image is the one set in Notion, or else the first body image, or else a drawn thumbnail
	let featuredImage: FeaturedImageValue | undefined;
	let thumbnail: string | undefined;
	if (article.featuredImage) {
		featuredImage = toFeaturedImage(await upload(article.featuredImage.url), article.title);
	} else if (firstImage) {
		featuredImage = toFeaturedImage(firstImage.media, firstImage.alt || article.title);
	} else if (options.thumbnail) {
		try {
			const outcome = await makeAutoThumbnail(api, article.title, options.postId, options.thumbnail.draw);
			if (outcome.kind === "made") {
				featuredImage = toFeaturedImage(outcome.media, article.title);
				thumbnail = "made a thumbnail";
			} else if (outcome.kind === "kept") {
				thumbnail = "kept the featured image chosen on the site";
			} else {
				thumbnail = "no thumbnail: the site does not have the Auto Thumbnail Design plugin";
			}
		} catch (error) {
			// The post is still sent, without a featured image
			thumbnail = `could not make the thumbnail, so sent without one: ${(error as Error).message}`;
		}
	}

	const taxonomies = await resolveTaxonomies(api, article.category, article.tags);

	const result = await sendPost(api, {
		id: options.postId,
		title: article.title,
		slug: article.slug || undefined,
		excerpt: article.excerpt || undefined,
		content: body.blocks,
		featuredImage,
		taxonomies,
		publish: options.publish,
	});

	return {
		...result,
		url: postUrl(api.siteUrl, result.slug),
		imagesUploaded: body.images.length + (article.featuredImage ? 1 : 0),
		thumbnail,
	};
}
