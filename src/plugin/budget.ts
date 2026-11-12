/**
 * Counts the calls one run makes. In the sandbox every call to the host
 * (settings, KV, storage, content, media) and every outside request counts
 * towards one limit per run (30 on Cloudflare, with no headroom: going over
 * throws). The plugin stops a little below it and carries on next run.
 */
export const RUN_BUDGET = 24;

export class OutOfBudget extends Error {
	override name = "OutOfBudget";
}

export class Budget {
	used = 0;
	readonly limit: number;

	constructor(limit = RUN_BUDGET) {
		this.limit = limit;
	}

	/** Whether `calls` more calls fit, keeping `reserve` for saving the progress. */
	has(calls: number, reserve = 1): boolean {
		return this.used + calls + reserve <= this.limit;
	}

	/**
	 * Counts a call that is about to be made, keeping `reserve` calls free.
	 * Throws when it does not fit. Only calls that change nothing (reads) may
	 * rely on this throw; writes check `has()` first, so that a unit of work
	 * is never left half done.
	 */
	take(calls = 1, reserve = 1): void {
		if (!this.has(calls, reserve)) throw new OutOfBudget(`Run budget of ${this.limit} calls used up`);
		this.used += calls;
	}
}
