/** Sends one Notion article to EmDash: images first, then the post. */

import type { ConvertResult } from "./convert.ts";
import type { EmDashApi, FetchLike } from "./emdash.ts";
import { downloadImage, fillImageBlock, type MediaItem, toFeaturedImage } from "./media.ts";
import type { Article } from "./notion.ts";
import { type PostResult, postUrl, sendPost } from "./publish.ts";
import { resolveTaxonomies } from "./taxonomy.ts";

export interface SendOptions {
	/** The post's ID from an earlier send; without it a new post is made. */
	postId?: string;
	publish: boolean;
	/** For reading images; tests replace it. */
	fetch?: FetchLike;
}

export interface SendResult extends PostResult {
	url: string;
	imagesUploaded: number;
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
	for (const image of body.images) {
		const url = image.asset.url;
		if (!url) continue;
		fillImageBlock(image, await upload(url));
	}

	const featuredImage = article.featuredImage
		? toFeaturedImage(await upload(article.featuredImage.url), article.title)
		: undefined;

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
		imagesUploaded: body.images.length + (featuredImage ? 1 : 0),
	};
}
