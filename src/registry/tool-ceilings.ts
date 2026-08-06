import { z } from 'zod'

/**
 * The reach vocabulary. Not read against write, but whether the thing takes effect without a
 * human having looked at it — the line every write guardrail in this server draws.
 *
 * - `read` returns data and changes nothing.
 * - `stage` creates or edits something inert: a macro nobody has applied, a trigger created
 *   `active: false`, a draft article no customer can see.
 * - `write` mutates a live object: a ticket, a user's name, an organization, a group.
 * - `delete` removes something, with no undo.
 * - `activate` makes a staged thing take effect — enabling a rule, publishing an article.
 *
 * A declaration is worst-case over what the tool can touch. `create_trigger` is `stage`
 * because the schema forces every rule it builds dormant; `update_trigger` is `write` because
 * its target may be a rule a human enabled last year, and rewriting that changes what fires
 * on live tickets with nobody having looked. Only a thing inert by nature — a macro, which
 * does nothing until an agent applies it — keeps its updates at `stage`.
 *
 * `activate` is in the vocabulary so that "this server never activates anything" is a type
 * rather than a habit, which is why `DeclarableLevel` excludes it: no tool may declare it and
 * no ceiling may permit it. Without the word, someone adds `enable_trigger` next year, calls
 * it `write` because it plainly is one, and every deployment with triggers at that ceiling
 * publishes it. The two types are kept separate deliberately — the full vocabulary is the
 * mechanism, the declarable subset is this server's policy, and a future server that does
 * activate things argues for its own subset rather than forking the vocabulary.
 */
export type ToolLevel = 'read' | 'stage' | 'write' | 'delete' | 'activate'
export type DeclarableLevel = Exclude<ToolLevel, 'activate'>

/**
 * `stage` sits below `write` deliberately: building something dormant is less reach than
 * touching something live. `activate` has no rank at all, so nothing can even compare against
 * it — a rank would imply a ceiling that permits it, and no ceiling may.
 */
const LEVEL_ORDER: Record<DeclarableLevel, number> = { read: 0, stage: 1, write: 2, delete: 3 }

export const isWithinCeiling = (level: DeclarableLevel, ceiling: DeclarableLevel): boolean =>
	LEVEL_ORDER[level] <= LEVEL_ORDER[ceiling]

// Derived from the rank table rather than restated, so a level cannot exist in the schema
// without an order or in the order without the schema.
const declarableLevelSchema = z.enum(
	Object.keys(LEVEL_ORDER) as [DeclarableLevel, ...DeclarableLevel[]]
)

export interface ResolvedCeilings {
	/**
	 * Never missing a group `resolveCeilings` was given, but the index signature cannot say
	 * which groups those were — so the `undefined` is in the type to make every consumer state
	 * its fallback, which must fail closed to `read`.
	 */
	ceilings: Record<string, DeclarableLevel | undefined>
	/** Why the config was refused, when it was. Every group then sits at `read`. */
	error?: string
}

/**
 * Resolves `TOOL_CEILINGS` from `env` into a ceiling per group, failing closed to `read` on
 * every group when the config is missing or malformed. Failing closed is silent in production
 * — the deploy succeeds and tools just vanish — so the caller has to log `error` loudly, and
 * a unit test parses the shipped `wrangler.jsonc` so a bad config cannot get past `validate`.
 *
 * A string is accepted and parsed as JSON because `.dev.vars` can shadow the var locally, and
 * everything arriving from there is a string. The schema is strict in both directions — every
 * group named, nothing extra — because a typo'd group name silently at `read` is exactly the
 * misconfiguration this refuses to half-accept.
 */
export const resolveCeilings = (raw: unknown, groups: readonly string[]): ResolvedCeilings => {
	const failClosed = (error: string): ResolvedCeilings => ({
		ceilings: Object.fromEntries(groups.map((group) => [group, 'read' as const])),
		error,
	})

	if (raw === undefined) return failClosed('TOOL_CEILINGS is not set')

	let candidate = raw
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return failClosed('TOOL_CEILINGS is a string that is not valid JSON')
		}
	}

	const parsed = z
		.strictObject(Object.fromEntries(groups.map((group) => [group, declarableLevelSchema])))
		.safeParse(candidate)

	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) =>
				issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
			)
			.join('; ')

		return failClosed(issues)
	}

	return { ceilings: parsed.data }
}
