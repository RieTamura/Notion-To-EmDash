/** Images: reading them from Notion, and the shapes EmDash keeps them in. Ported from Post To EmDash's media.ts. */

import type { FetchLike } from "./emdash.ts";
import type { ImageBlock } from "./portable-text.ts";

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
	data: Uint8Array;
	type: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
};

const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
};

/** Images larger than this are not read (EmDash would refuse them anyway). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function mimeTypeOf(filename: string): string | undefined {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[ext];
}

/** The file name at the end of a URL ("photo.png"), without the query. */
export function fileNameFromUrl(url: string): string {
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
		return decodeURIComponent(last);
	} catch {
		return "";
	}
}

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

	let name = fileNameFromUrl(url);
	const headerType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
	const type = (headerType?.startsWith("image/") ? headerType : undefined) ?? mimeTypeOf(name);
	if (!type) throw new ImageDownloadError(`${shortUrl(url)} is not an image`);
	if (!mimeTypeOf(name)) name = `${name || "image"}.${EXTENSION_BY_MIME[type] ?? "bin"}`;
	return { name, data, type };
}

/** The URL without its query, for messages (Notion's signed links are long and secret-ish). */
export function shortUrl(url: string): string {
	return url.split("?")[0]!;
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
