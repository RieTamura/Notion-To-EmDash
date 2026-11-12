/**
 * Calls the EmDash REST API (/_emdash/api/…). Ported from Post To EmDash's api.ts,
 * with Obsidian's requestUrl replaced by fetch.
 */

import type { MediaItem } from "./media.ts";

/** An error returned by the EmDash API, or a failed connection. */
export class EmDashError extends Error {
	override name = "EmDashError";
	/** HTTP status; 0 when the site could not be reached. */
	readonly status: number;
	/** EmDash's error code (INSUFFICIENT_SCOPE and so on); empty when unknown. */
	readonly code: string;

	constructor(message: string, status: number, code = "") {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiEnvelope<T> {
	success?: boolean;
	data?: T;
	error?: { code?: string; message?: string };
}

/** The part of the API that publish.ts and taxonomy.ts use, so tests can stand in for it. */
export interface ApiLike {
	request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface EmDashApiOptions {
	/** Site origin without a trailing slash. */
	siteUrl: string;
	token: string;
	fetch?: FetchLike;
	timeoutMs?: number;
}

/** Uploads can be large, so they get at least this long. */
const UPLOAD_TIMEOUT_MS = 60_000;

export class EmDashApi implements ApiLike {
	readonly siteUrl: string;
	private readonly token: string;
	private readonly fetch: FetchLike;
	private readonly timeoutMs: number;

	constructor(options: EmDashApiOptions) {
		this.siteUrl = options.siteUrl;
		this.token = options.token;
		this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		return this.send<T>(method, path, body === undefined ? undefined : JSON.stringify(body), {
			"Content-Type": "application/json",
		});
	}

	/**
	 * Uploads an image to the media library. The same image is not stored twice:
	 * with `deduplicate`, EmDash returns the earlier copy.
	 */
	async uploadImage(file: { name: string; data: Uint8Array<ArrayBuffer>; type: string }): Promise<MediaItem> {
		const form = new FormData();
		form.append("deduplicate", "true");
		form.append("file", new Blob([file.data], { type: file.type }), file.name);
		const data = await this.send<{ item: MediaItem }>("POST", "/media", form, {}, Math.max(this.timeoutMs, UPLOAD_TIMEOUT_MS));
		return data.item;
	}

	/** Checks that the token can read posts (content:read is enough). */
	async checkConnection(): Promise<void> {
		await this.request("GET", "/content/posts?limit=1");
	}

	private async send<T>(
		method: string,
		path: string,
		body: string | FormData | undefined,
		headers: Record<string, string>,
		timeoutMs = this.timeoutMs,
	): Promise<T> {
		let response: Response;
		try {
			response = await this.fetch(`${this.siteUrl}/_emdash/api${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					// Not needed with a Bearer token, but Post To EmDash sends it and older sites may ask for it
					"X-EmDash-Request": "1",
					...(body === undefined ? {} : headers),
				},
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const timedOut = error instanceof Error && error.name === "TimeoutError";
			throw new EmDashError(timedOut ? `EmDash did not answer within ${timeoutMs / 1000} s` : `Could not reach EmDash: ${String(error)}`, 0);
		}

		let json: ApiEnvelope<T> | null = null;
		try {
			json = (await response.json()) as ApiEnvelope<T>;
		} catch {
			// Not JSON (an HTML page, for example): the URL is probably not an EmDash site
		}
		if (response.ok && json && json.success !== false) return json.data as T;
		throw new EmDashError(
			json?.error?.message ?? `EmDash returned HTTP ${response.status}`,
			response.status,
			json?.error?.code ?? (json ? "" : "NOT_EMDASH"),
		);
	}
}
