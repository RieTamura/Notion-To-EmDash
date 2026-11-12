/** File names and types for images read from Notion. Shared by the plugin and the GitHub Actions tool. */

export const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
};

export const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
};

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

/** The URL without its query, for messages (Notion's signed links are long and secret-ish). */
export function shortUrl(url: string): string {
	return url.split("?")[0]!;
}


/**
 * A file name with an extension that matches the image type, from the URL and
 * the Content-Type header. Null when the response is not an image.
 */
export function imageFileName(url: string, contentType: string | null): { name: string; type: string } | null {
	let name = fileNameFromUrl(url);
	const headerType = contentType?.split(";")[0]?.trim().toLowerCase();
	const type = (headerType?.startsWith("image/") ? headerType : undefined) ?? mimeTypeOf(name);
	if (!type) return null;
	if (!mimeTypeOf(name)) name = `${name || "image"}.${EXTENSION_BY_MIME[type] ?? "bin"}`;
	return { name, type };
}
