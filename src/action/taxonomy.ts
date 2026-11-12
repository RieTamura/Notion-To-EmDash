/** Turns the Notion category and tags into the site's term slugs. Ported from Post To EmDash's taxonomy.ts. */

import type { ApiLike } from "./emdash.ts";

interface Term {
	slug: string;
	label: string;
	children?: Term[];
}

/** The category is not on the site. Categories are never created by this tool. */
export class UnknownCategoryError extends Error {
	override name = "UnknownCategoryError";
	readonly category: string;
	readonly available: string[];

	constructor(category: string, available: string[]) {
		super(`The category "${category}" is not on the site (it has: ${available.join(", ") || "none"})`);
		this.category = category;
		this.available = available;
	}
}

/** Names are compared without case and surrounding spaces. */
const normalize = (value: string) => value.trim().toLowerCase();

function flatten(terms: Term[]): Term[] {
	return terms.flatMap((t) => [t, ...flatten(t.children ?? [])]);
}

async function listTerms(api: ApiLike, taxonomy: string): Promise<Term[]> {
	const data = await api.request<{ terms: Term[] }>("GET", `/taxonomies/${taxonomy}/terms`);
	return flatten(data.terms ?? []);
}

function find(terms: Term[], name: string): Term | undefined {
	const n = normalize(name);
	return terms.find((t) => normalize(t.label) === n) ?? terms.find((t) => normalize(t.slug) === n);
}

/**
 * The taxonomies to send. A taxonomy left empty in Notion is not sent, so terms added
 * in the admin stay. Missing tags are created; they are always looked up first, because
 * creating one with the same name would make a second tag with "-1" on its slug.
 */
export async function resolveTaxonomies(
	api: ApiLike,
	category: string | null,
	tags: string[],
): Promise<Record<string, string[]>> {
	const result: Record<string, string[]> = {};

	if (category) {
		const terms = await listTerms(api, "category");
		const term = find(terms, category);
		if (!term) throw new UnknownCategoryError(category, terms.map((t) => t.label));
		result.category = [term.slug];
	}

	if (tags.length) {
		const terms = await listTerms(api, "tag");
		const slugs: string[] = [];
		for (const tag of tags) {
			let term = find(terms, tag);
			if (!term) {
				const created = await api.request<{ term: Term }>("POST", "/taxonomies/tag/terms", { label: tag });
				term = created.term;
				terms.push(term);
			}
			if (!slugs.includes(term.slug)) slugs.push(term.slug);
		}
		result.tag = slugs;
	}

	return result;
}
