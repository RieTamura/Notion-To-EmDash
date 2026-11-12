/** Images: reading them from Notion, and the shapes EmDash keeps them in. Ported from Post To EmDash's media.ts. */

import type { FetchLike } from "./emdash.ts";
import { fileNameFromUrl, imageFileName, mimeTypeOf, shortUrl } from "../shared/image-name.ts";
import type { ImageBlock } from "../shared/portable-text.ts";

export { fileNameFromUrl, mimeTypeOf, shortUrl };

/** A media item returned by POST /media. */
export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	width?: number | null;
	height?: number | null;
	storageKey: string;
	url: string;
	blurhash?: string | null;
	dominantColor?: string | null;
}

/** The shape of a post's featured_image (the same as when it is picked in the admin). */
export interface FeaturedImageValue {
	provider: "local";
	id: string;
	alt: string;
	width?: number;
	height?: number;
	mimeType: string;
	filename: string;
	meta: { storageKey: string };
}

export interface ImageFile {
	name: string;
	data: Uint8Array<ArrayBuffer>;
	type: string;
}

/** Images larger than this are not read (EmDash would refuse them anyway). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class ImageDownloadError extends Error {
	override name = "ImageDownloadError";
}

/**
 * Reads an image from Notion (or from the external link the writer pasted).
 * Notion's own links stop working after an hour, so this runs right before the upload.
 */
export async function downloadImage(url: string, fetchFn: FetchLike = (input, init) => globalThis.fetch(input, init)): Promise<ImageFile> {
	let response: Response;
	try {
		response = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
	} catch (error) {
		throw new ImageDownloadError(`Could not read the image ${shortUrl(url)}: ${String(error)}`);
	}
	if (!response.ok) {
		throw new ImageDownloadError(`Could not read the image ${shortUrl(url)}: HTTP ${response.status}`);
	}
	const length = Number(response.headers.get("Content-Length"));
	if (length > MAX_IMAGE_BYTES) {
		throw new ImageDownloadError(`The image ${shortUrl(url)} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
	}
	const data = new Uint8Array(await response.arrayBuffer());
	if (data.byteLength > MAX_IMAGE_BYTES) {
		throw new ImageDownloadError(`The image ${shortUrl(url)} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
	}

	const file = imageFileName(url, response.headers.get("Content-Type"));
	if (!file) throw new ImageDownloadError(`${shortUrl(url)} is not an image`);
	return { ...file, data };
}

/** Puts an uploaded image into a body image block. */
export function fillImageBlock(block: ImageBlock, media: MediaItem): void {
	block.asset = { _ref: media.id, url: media.url, provider: "local" };
	if (media.width) block.width = media.width;
	if (media.height) block.height = media.height;
	if (media.blurhash) block.blurhash = media.blurhash;
	if (media.dominantColor) block.dominantColor = media.dominantColor;
}

export function toFeaturedImage(media: MediaItem, alt: string): FeaturedImageValue {
	const image: FeaturedImageValue = {
		provider: "local",
		id: media.id,
		alt,
		mimeType: media.mimeType,
		filename: media.filename,
		meta: { storageKey: media.storageKey },
	};
	if (media.width) image.width = media.width;
	if (media.height) image.height = media.height;
	return image;
}
