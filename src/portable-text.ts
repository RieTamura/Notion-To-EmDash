/**
 * The Portable Text shapes this tool sends to EmDash.
 *
 * They are the same as the output of Post To EmDash's convert.ts, so both tools write
 * article bodies that the site renders the same way.
 */

export interface Span {
	_type: "span";
	_key: string;
	text: string;
	marks: string[];
}

export interface LinkDef {
	_type: "link";
	_key: string;
	href: string;
}

export interface TextBlock {
	_type: "block";
	_key: string;
	style: string;
	listItem?: "bullet" | "number";
	level?: number;
	markDefs: LinkDef[];
	children: Span[];
}

export interface CodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
}

export interface ImageBlock {
	_type: "image";
	_key: string;
	alt: string;
	/** Right after converting, `url` holds the Notion image link. After upload it is replaced by `_ref`. */
	asset: { url?: string; _ref?: string; provider?: string };
	width?: number;
	height?: number;
	blurhash?: string;
	dominantColor?: string;
}

export interface BreakBlock {
	_type: "break";
	_key: string;
	style: "line";
}

export interface TableCell {
	_type: "tableCell";
	_key: string;
	content: Span[];
	markDefs: LinkDef[];
	isHeader?: boolean;
	textAlign?: "left" | "center" | "right";
}

export interface TableRow {
	_type: "tableRow";
	_key: string;
	cells: TableCell[];
}

export interface TableBlock {
	_type: "table";
	_key: string;
	hasHeaderRow: boolean;
	rows: TableRow[];
}

export type Block = TextBlock | CodeBlock | ImageBlock | BreakBlock | TableBlock;
