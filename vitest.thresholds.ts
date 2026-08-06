/**
 * Per-file coverage thresholds, deliberately kept out of `vitest.config.ts`.
 *
 * They live here because of how the reporting action on CI reads them. It does
 * not parse the config: it runs regexes over the raw file text, one per metric,
 * takes the first match anywhere in the file and presents it as a target for
 * the whole project. Glob keys mean nothing to it. With these entries in the
 * config, it reads the first block below and captions every overall metric with
 * a 100% target, marking all four red — the exact opposite of the intent, since
 * there is no global threshold here and deliberately so.
 *
 * Moved out, those regexes find nothing, the comment shows the percentages with
 * no target beside them, and Vitest enforces every entry below exactly as it
 * would inline. Keep the numbers in this file rather than moving them back.
 *
 * Every number is the measured value rounded down, with enough slack that
 * unrelated work does not trip it. They ratchet against erosion; they are not a
 * target to climb. Raise one when real coverage lands. Say so in the commit when
 * you lower one, because that is coverage being given up.
 *
 * What carries no pin is deliberate too: the vendored OAuth helper is
 * quarantined debt (#2), `require-changes` and the upstream-OAuth helpers are
 * covered through their consumers in the apps built on this package, and the
 * barrels have nothing to decide. They all stay in the denominator so the holes
 * are visible, per the coverage.include comment in vitest.config.ts.
 */
export const coverageThresholds = {
	// The decode helper decides — try the bytes as UTF-8, fall back to the legacy format —
	// and the fallback is what keeps year-old approval cookies readable, so losing its test
	// would be losing the rollout guarantee, not a number.
	'src/oauth/base64.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	// The two halves of the publication policy: what a config resolves to, and what a ceiling
	// publishes. Both are small and decide everything about which tools a client is offered,
	// so any drop here is a regression in the security boundary rather than a rounding
	// artefact.
	'src/registry/tool-ceilings.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	'src/registry/tool-registry.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	'src/registry/error-handling.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	// The factory owns the two invariants that fail silently under local testing — a fresh
	// server per request, the announcement once per isolate — so a drop here is a regression
	// in exactly the code whose failure mode is invisible until load.
	'src/index.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	// The transport carries the retry decisions, the deadline arithmetic and the Retry-After
	// handling. Branches measured 91 at the lift; the uncovered arms are the not-a-URL
	// redirect Location, the non-Error rethrow, and the unreachable throw ending the retry
	// loop. Functions sits below 100 for one reason: `send`, the verb→policy dispatch, is a
	// one-line delegation that the zendesk client's integration tests drive and this package's
	// transport suite does not reach on its own — measured 92 at the lift.
	'src/http/http-client.ts': { branches: 90, functions: 92 },
	// It pins 100 on branches, which it could not do while the "what did this throw" ternary
	// was written out at each of five catch sites: `atob`, `JSON.parse` and `btoa` all throw
	// real Errors, so four of those five pairs had an arm nothing could reach. Behind one
	// `reasonFor` helper there is a single pair, and the provider stub throwing a bare string
	// covers it. Do not read the 100 as every path being exercised — see the note on
	// POST /authorize in the test file, where the module mock makes coverage report a guarded
	// and an unguarded route identically.
	'src/oauth/google-handler.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
}
