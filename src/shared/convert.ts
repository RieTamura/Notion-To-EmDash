/**
 * Turns Notion blocks into Portable Text for EmDash.
 *
 * The result has the same shape as Post To EmDash's convert.ts. Notion blocks that the site
 * cannot show (sub-pages, databases, files hosted by Notion, ...) are left out and reported in
 * `skipped`, so the run can tell the writer what did not make it.
 */

import type { Block, ImageBlock, LinkDef, Span, TableCell, TextBlock } from "./portable-text.ts";

/* ---------- Shapes of the Notion objects read here ---------- */

export interface RichTextItem {
	type: "text" | "mention" | "equation";
	plain_text: string;
	href: string | null;
	annotations?: {
		bold?: boolean;
		italic?: boolean;
		strikethrough?: boolean;
		underline?: boolean;
		code?: boolean;
	};
	text?: { content: string; link: { url: string } | null };
	mention?: { type: string; page?: { id: string } };
	equation?: { expression: string };
}

export interface NotionFileObject {
	type: "file" | "external" | "file_upload";
	file?: { url: string; expiry_time?: string };
	external?: { url: string };
	caption?: RichTextItem[];
	name?: string;
}

/** A block with its children already read (see NotionClient.getBlockTree). */
export interface NotionBlock {
	id: string;
	type: string;
	has_children?: boolean;
	children?: NotionBlock[];
	[key: string]: unknown;
}

export interface ConvertOptions {
	/**
	 * Where a link to another Notion page should point. Return the page's EmDash URL when it has
	 * been sent, or null to keep only the text (Notion links are private to the workspace).
	 */
	resolvePageLink?: (pageId: string) => string | null;
}

export interface SkippedBlock {
	type: string;
	reason: string;
}

export interface ConvertResult {
	blocks: Block[];
	/** The image blocks inside `blocks`, for uploading. */
	images: ImageBlock[];
	skipped: SkippedBlock[];
}

/* ---------- Block content shapes ---------- */

interface TextContent {
	rich_text?: RichTextItem[];
	checked?: boolean;
	is_toggleable?: boolean;
	icon?: { type: string; emoji?: string } | null;
	language?: string;
	expression?: string;
	url?: string;
	caption?: RichTextItem[];
	has_column_header?: boolean;
	has_row_header?: boolean;
	cells?: RichTextItem[][];
}

/** Notion's heading 1 is the first level inside the article, so it becomes h2 (the title is h1). */
const HEADING_STYLES: Record<string, string> = {
	heading_1: "h2",
	heading_2: "h3",
	heading_3: "h4",
	heading_4: "h5",
};

/** Blocks whose children are simply the article's content, placed where the block was. */
const TRANSPARENT = new Set(["column_list", "column", "synced_block", "tab"]);

const SKIP_REASONS: Record<string, string> = {
	child_page: "sub-pages are not sent",
	child_database: "databases are not sent",
	link_to_page: "links to pages inside Notion are not sent",
	table_of_contents: "the site makes its own table of contents",
	breadcrumb: "not shown on the site",
	template: "not shown on the site",
	meeting_notes: "not shown on the site",
	transcription: "not shown on the site",
	unsupported: "Notion cannot share this block through its API",
};

/** Notion's code language names that differ from the names the site's highlighter knows. */
const LANGUAGES: Record<string, string | undefined> = {
	"plain text": undefined,
	"java/c/c++/c#": undefined,
	"c++": "cpp",
	"c#": "csharp",
	"f#": "fsharp",
	"vb.net": "vb",
	"visual basic": "vb",
	markup: "html",
};

const NOTION_HOSTS = /^https?:\/\/(?:[\w-]+\.)?(?:notion\.so|notion\.site|notion\.com)\//;
const PAGE_ID = /([0-9a-f]{32})(?:[?#]|$)/;

class Converter {
	private keyCounter = 0;
	readonly blocks: Block[] = [];
	readonly images: ImageBlock[] = [];
	readonly skipped: SkippedBlock[] = [];
	private readonly options: ConvertOptions;

	constructor(options: ConvertOptions) {
		this.options = options;
	}

	key(): string {
		return `k${(this.keyCounter++).toString(36)}`;
	}

	/** `listLevel` is the level of the list the blocks sit in (0 when not in a list). */
	run(blocks: NotionBlock[], listLevel = 0, style = "normal"): void {
		for (const block of blocks) this.convert(block, listLevel, style);
	}

	private convert(block: NotionBlock, listLevel: number, style: string): void {
		const type = block.type;
		const content = (block[type] ?? {}) as TextContent;
		const children = block.children ?? [];

		if (type === "paragraph") {
			if (content.rich_text?.length) this.pushText(content.rich_text, style);
			this.run(children, listLevel, style);
			return;
		}
		if (type in HEADING_STYLES) {
			if (content.rich_text?.length) this.pushText(content.rich_text, HEADING_STYLES[type]!);
			// A toggle heading's hidden content becomes ordinary content under the heading
			this.run(children);
			return;
		}
		if (type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do") {
			const block = this.makeTextBlock(content.rich_text ?? [], "normal");
			if (type === "to_do") block.children.unshift(this.span(content.checked ? "☑ " : "☐ ", []));
			block.listItem = type === "numbered_list_item" ? "number" : "bullet";
			block.level = listLevel + 1;
			this.blocks.push(block);
			this.run(children, listLevel + 1);
			return;
		}
		if (type === "quote" || type === "callout") {
			const text = [...(content.rich_text ?? [])];
			const emoji = type === "callout" && content.icon?.type === "emoji" ? content.icon.emoji : undefined;
			if (emoji) text.unshift(plain(`${emoji} `));
			if (text.length) this.pushText(text, "blockquote");
			// Paragraphs inside a quote stay in the quote; other blocks follow it
			this.run(children, 0, "blockquote");
			return;
		}
		if (type === "toggle") {
			if (content.rich_text?.length) this.pushText(content.rich_text, style);
			this.run(children, listLevel, style);
			return;
		}
		if (type === "code") {
			const code = (content.rich_text ?? []).map((item) => item.plain_text).join("");
			const language = codeLanguage(content.language);
			this.blocks.push({ _type: "code", _key: this.key(), code, ...(language ? { language } : {}) });
			return;
		}
		if (type === "equation") {
			// The site cannot draw formulas, so they are shown as LaTeX code (as Post To EmDash does)
			this.blocks.push({ _type: "code", _key: this.key(), code: content.expression ?? "", language: "latex" });
			return;
		}
		if (type === "divider") {
			this.blocks.push({ _type: "break", _key: this.key(), style: "line" });
			return;
		}
		if (type === "image") {
			this.pushImage(block[type] as NotionFileObject);
			return;
		}
		if (type === "table") {
			this.pushTable(content, children);
			return;
		}
		if (type === "bookmark" || type === "embed" || type === "link_preview" || type === "video") {
			this.pushLinkBlock(type, block[type] as NotionFileObject & { url?: string });
			return;
		}
		if (type === "file" || type === "pdf" || type === "audio") {
			this.pushLinkBlock(type, block[type] as NotionFileObject);
			return;
		}
		if (TRANSPARENT.has(type)) {
			this.run(children, listLevel, style);
			return;
		}
		this.skipped.push({ type, reason: SKIP_REASONS[type] ?? "this kind of block is not supported yet" });
	}

	private pushImage(file: NotionFileObject): void {
		const url = fileUrl(file);
		if (!url) {
			this.skipped.push({ type: "image", reason: "the image has no link to read it from" });
			return;
		}
		const image: ImageBlock = { _type: "image", _key: this.key(), alt: plainText(file.caption), asset: { url } };
		this.blocks.push(image);
		this.images.push(image);
	}

	private pushTable(content: TextContent, rows: NotionBlock[]): void {
		const rowHeader = content.has_row_header === true;
		const hasHeaderRow = content.has_column_header === true;
		const tableRows = rows.filter((row) => row.type === "table_row");
		if (!tableRows.length) return;
		const width = Math.max(...tableRows.map((row) => ((row.table_row as TextContent).cells ?? []).length));
		this.blocks.push({
			_type: "table",
			_key: this.key(),
			hasHeaderRow,
			rows: tableRows.map((row, rowIndex) => ({
				_type: "tableRow" as const,
				_key: this.key(),
				cells: Array.from({ length: width }, (_, col) => {
					const { spans, markDefs } = this.parseRichText(((row.table_row as TextContent).cells ?? [])[col] ?? []);
					const cell: TableCell = { _type: "tableCell", _key: this.key(), content: spans, markDefs };
					if ((hasHeaderRow && rowIndex === 0) || (rowHeader && col === 0)) cell.isHeader = true;
					return cell;
				}),
			})),
		});
	}

	/** Bookmarks, embeds, videos and files become a paragraph with a link. */
	private pushLinkBlock(type: string, value: NotionFileObject & { url?: string }): void {
		if (value.type === "file" || value.type === "file_upload") {
			// Notion's own file links stop working after an hour, so a link to them would break
			this.skipped.push({ type, reason: "files kept in Notion are not sent; use a link to a file elsewhere" });
			return;
		}
		const url = value.url ?? value.external?.url;
		if (!url) {
			this.skipped.push({ type, reason: "it has no link" });
			return;
		}
		const caption = value.caption ?? [];
		const label = caption.length ? caption : [plain(value.name || url)];
		const link: RichTextItem[] = label.map((item) => ({ ...item, href: url, text: { content: item.plain_text, link: { url } } }));
		this.pushText(link, "normal");
	}

	private pushText(richText: RichTextItem[], style: string): void {
		this.blocks.push(this.makeTextBlock(richText, style));
	}

	private makeTextBlock(richText: RichTextItem[], style: string): TextBlock {
		const { spans, markDefs } = this.parseRichText(richText);
		return { _type: "block", _key: this.key(), style, markDefs, children: spans };
	}

	parseRichText(richText: RichTextItem[]): { spans: Span[]; markDefs: LinkDef[] } {
		const markDefs: LinkDef[] = [];
		const spans: Span[] = [];
		for (const item of richText) {
			const marks: string[] = [];
			const a = item.annotations ?? {};
			if (a.bold) marks.push("strong");
			if (a.italic) marks.push("em");
			if (a.underline) marks.push("underline");
			if (a.strikethrough) marks.push("strike-through");
			if (a.code || item.type === "equation") marks.push("code");

			const href = this.linkTarget(item);
			if (href) {
				// Notion splits a link into pieces when the styling changes inside it; keep one link
				let def = markDefs.find((d) => d.href === href);
				if (!def) {
					def = { _type: "link", _key: this.key(), href };
					markDefs.push(def);
				}
				marks.push(def._key);
			}

			const text = item.type === "equation" ? (item.equation?.expression ?? item.plain_text) : item.plain_text;
			if (!text) continue;
			const last = spans[spans.length - 1];
			if (last && sameMarks(last.marks, marks)) last.text += text;
			else spans.push(this.span(text, marks));
		}
		if (!spans.length) spans.push(this.span("", []));
		return { spans, markDefs };
	}

	/** The link to put on a piece of text, or null. Links into Notion are kept only when resolvable. */
	private linkTarget(item: RichTextItem): string | null {
		if (item.type === "mention") {
			if (item.mention?.type === "page" && item.mention.page) {
				return this.options.resolvePageLink?.(item.mention.page.id) ?? null;
			}
			if (item.mention?.type === "link_preview") return item.href;
			return null;
		}
		const url = item.text?.link?.url ?? item.href;
		if (!url) return null;
		if (url.startsWith("/") || NOTION_HOSTS.test(url)) {
			const id = url.replace(/-/g, "").match(PAGE_ID)?.[1];
			return id ? (this.options.resolvePageLink?.(toUuid(id)) ?? null) : null;
		}
		return url;
	}

	private span(text: string, marks: string[]): Span {
		return { _type: "span", _key: this.key(), text, marks };
	}
}

function plain(text: string): RichTextItem {
	return { type: "text", plain_text: text, href: null, text: { content: text, link: null } };
}

function plainText(items: RichTextItem[] | undefined): string {
	return (items ?? []).map((item) => item.plain_text).join("");
}

function sameMarks(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((mark, i) => mark === b[i]);
}

function fileUrl(file: NotionFileObject | undefined): string | null {
	if (!file) return null;
	if (file.type === "external") return file.external?.url ?? null;
	return file.file?.url ?? null;
}

export function codeLanguage(language: string | undefined): string | undefined {
	if (!language) return undefined;
	const name = language.toLowerCase();
	if (name in LANGUAGES) return LANGUAGES[name];
	return name.replace(/\s+/g, "-");
}

function toUuid(id: string): string {
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function convertBlocks(blocks: NotionBlock[], options: ConvertOptions = {}): ConvertResult {
	const converter = new Converter(options);
	converter.run(blocks);
	return { blocks: converter.blocks, images: converter.images, skipped: converter.skipped };
}
