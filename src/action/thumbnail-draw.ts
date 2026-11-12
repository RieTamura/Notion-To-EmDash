/**
 * Draws the automatic thumbnail. Ported from Post To EmDash's thumbnail-draw.ts:
 * the browser's canvas, FontFace and createImageBitmap are replaced by @napi-rs/canvas,
 * so the picture comes out the same as the plugin's preview.
 */

import { createCanvas, GlobalFonts, type Image, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { fontCssUrl, logoLayout, META_SIZES, metaLayout, parseFontCss, type ThumbnailDesign, wrapText } from "./thumbnail.ts";

/** Reads a URL. Null when it fails. */
export type Fetcher = (url: string) => Promise<{ data: Uint8Array; text: string } | null>;

/** Reads with fetch. Google Fonts sends TrueType files to a client it does not know, which the canvas reads. */
export const fetchFetcher: Fetcher = async (url) => {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) return null;
		const data = new Uint8Array(await response.arrayBuffer());
		return { data, get text() { return new TextDecoder().decode(data); } };
	} catch {
		return null;
	}
};

const PADDING = 72;
const TITLE_SIZES = [64, 56, 48];
const TITLE_MAX_LINES = 3;

/** Each drawing loads only the characters it uses, so each gets its own family name. */
let fontCount = 0;

/**
 * Loads the font from Google Fonts. Without it, the title is drawn in the system's sans-serif.
 * Returns the CSS font family and a function that unloads the font after drawing.
 */
async function loadFont(design: ThumbnailDesign, text: string, fetch: Fetcher): Promise<{ family: string; unload: () => void }> {
	const family = `NotionToEmDash ${design.font} ${++fontCount}`;
	const keys: NonNullable<ReturnType<typeof GlobalFonts.register>>[] = [];
	const unload = () => {
		if (keys.length) GlobalFonts.removeBatch(keys);
	};
	try {
		const css = await fetch(fontCssUrl(design.font, ["500", "700"], text));
		if (!css) throw new Error("could not read the font list");
		for (const face of parseFontCss(css.text)) {
			const file = await fetch(face.url);
			if (!file) continue;
			const key = GlobalFonts.register(Buffer.from(file.data), family);
			if (key) keys.push(key);
		}
		if (!keys.length) throw new Error("no font file could be loaded");
		return { family: `"${family}", sans-serif`, unload };
	} catch (error) {
		console.warn(`  thumbnail: drawing in the default font, as ${design.font} could not be loaded (${(error as Error).message})`);
		unload();
		return { family: "sans-serif", unload: () => {} };
	}
}

async function loadBitmap(url: string | null, fetch: Fetcher): Promise<Image | null> {
	if (!url) return null;
	try {
		const file = await fetch(url);
		return file ? await loadImage(Buffer.from(file.data)) : null;
	} catch (error) {
		console.warn(`  thumbnail: could not read the image ${url} (${(error as Error).message})`);
		return null;
	}
}

/** Covers the frame with the image, keeping its shape (the parts outside are cut off). */
function drawCover(ctx: SKRSContext2D, image: Image, width: number, height: number): void {
	const scale = Math.max(width / image.width, height / image.height);
	const w = image.width * scale;
	const h = image.height * scale;
	ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

/**
 * Makes a PNG with the title and date on the site's design.
 * siteUrl is for the design's images, which come as URLs relative to the site.
 */
export async function drawThumbnail(
	design: ThumbnailDesign,
	text: { title: string; date: string },
	siteUrl: string,
	fetch: Fetcher = fetchFetcher,
): Promise<Uint8Array<ArrayBuffer>> {
	const { width, height } = design;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	const [font, background, logo] = await Promise.all([
		loadFont(design, `${text.title}${text.date}${design.siteName ?? ""}…`, fetch),
		loadBitmap(design.background.image && siteUrl + design.background.image, fetch),
		loadBitmap(design.logo && siteUrl + design.logo, fetch),
	]);
	const fontFamily = font.family;

	try {
		ctx.fillStyle = design.background.color;
		ctx.fillRect(0, 0, width, height);
		if (background) {
			drawCover(ctx, background, width, height);
			if (design.background.overlay) {
				const inset = PADDING / 2;
				ctx.globalAlpha = 0.85;
				ctx.fillStyle = design.background.color;
				ctx.beginPath();
				ctx.roundRect(inset, inset, width - inset * 2, height - inset * 2, 24);
				ctx.fill();
				ctx.globalAlpha = 1;
			}
		}

		ctx.fillStyle = design.textColor;
		ctx.textBaseline = "alphabetic";

		// Title: smaller until it fits. If it still does not fit at the smallest size, it ends with "…"
		const maxWidth = width - PADDING * 2;
		let title = { lines: [] as string[], size: TITLE_SIZES[0]! };
		for (const size of TITLE_SIZES) {
			ctx.font = `700 ${size}px ${fontFamily}`;
			const wrapped = wrapText(text.title, maxWidth, TITLE_MAX_LINES, (s) => ctx.measureText(s).width);
			title = { lines: wrapped.lines, size };
			if (!wrapped.truncated) break;
		}
		ctx.font = `700 ${title.size}px ${fontFamily}`;
		const lineHeight = title.size * 1.45;
		title.lines.forEach((line, i) => ctx.fillText(line, PADDING, PADDING + title.size + i * lineHeight));

		// Bottom row: the date, and the logo with the site name, on the sides chosen in the design
		const baseline = height - PADDING;
		const metaSize = META_SIZES[design.metaSize];
		ctx.font = `500 ${metaSize.text}px ${fontFamily}`;
		const logoBox = logo && logoLayout(logo.width, logo.height, metaSize.logo, design.logoShape);
		const meta = metaLayout({
			width,
			padding: PADDING,
			baseline,
			dateWidth: ctx.measureText(text.date).width,
			logoWidth: logoBox?.width ?? 0,
			nameWidth: design.siteName ? ctx.measureText(design.siteName).width : 0,
			datePosition: design.datePosition,
			logoPosition: design.logoPosition,
			scale: metaSize.text / META_SIZES.normal.text,
		});
		ctx.fillText(text.date, meta.dateX, meta.dateBaseline);
		if (design.siteName) ctx.fillText(design.siteName, meta.nameX, baseline);
		if (logo && logoBox) {
			const { source, width: w, height: h, radius } = logoBox;
			const x = meta.logoX;
			// Centred on the middle of the text
			const y = baseline - metaSize.text * 0.35 - h / 2;
			ctx.save();
			if (radius > 0) {
				ctx.beginPath();
				ctx.roundRect(x, y, w, h, radius);
				ctx.clip();
			}
			ctx.drawImage(logo, source.x, source.y, source.width, source.height, x, y, w, h);
			ctx.restore();
		}

		return new Uint8Array(await canvas.encode("png"));
	} finally {
		font.unload();
	}
}
