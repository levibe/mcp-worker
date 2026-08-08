import type { McpServer } from '@modelcontextprotocol/server'
import { z, type ZodRawShape } from 'zod'
import type { InferParams, ToolDefinition } from './types'
import { isWithinCeiling, type DeclarableLevel, type ResolvedCeilings } from './tool-ceilings'
import { withErrorHandling } from './error-handling'

/**
 * The backstop for a group the ceilings never named: fail closed to `read`. Registration and
 * the announcement both go through this one expression, so the log can never claim more or
 * less than registration actually does.
 */
const ceilingFor = (ceilings: ResolvedCeilings['ceilings'], group: string): DeclarableLevel =>
	ceilings[group] ?? 'read'

/**
 * Registers the tools the ceiling permits, returning the names of those it withheld.
 *
 * Publication is a comparison of data — the tool's declared level against the group's
 * configured ceiling — and deliberately nothing cleverer. The name plays no part, so a
 * `create_` prefix publishes nothing by itself; and because both sides are runtime values,
 * a withheld tool is ordinary reachable code to the compiler and the linter, not a branch
 * they can prove dead. Registration is still the security boundary it always was: a tool
 * withheld here cannot be called by any client, whatever the tool list a client cached
 * happens to say.
 */
export const registerTools = <C>(
	server: McpServer,
	client: C,
	tools: ToolDefinition<C>[],
	ceiling: DeclarableLevel,
): string[] => {
	const withheld: string[] = []

	tools.forEach((tool) => {
		if (!isWithinCeiling(tool.level, ceiling)) {
			withheld.push(tool.name)
			return
		}

		// `z.object` around the shape is what keeps this off a deprecated path. SDK v2 still
		// accepts a bare `{ field: z.string() }` record and wraps it internally, but that
		// overload is marked deprecated, so the wrapping happens here instead. Tool definitions
		// are unaffected and still spread shared shapes like `paginationSchema` directly.
		//
		// This is the only place a handler's result becomes a response, which is why the worded
		// confirmation has to arrive here as data. See `withErrorHandling` for what wrapping one
		// a second time costs.
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: z.object(tool.schema) },
			withErrorHandling(tool.handler.bind(null, client), tool.successMessage),
		)
	})

	return withheld
}

/**
 * Registers every tool category against its own ceiling, returning every name it withheld.
 *
 * A group the config never named falls closed to `read`. The config schema requires every
 * group, so this only happens when a new category lands in `toolCategories` before the
 * shipped `TOOL_CEILINGS` names it — a consumer's own config test is what fails `validate`
 * on exactly that drift, and this fallback is the runtime backstop, not the mechanism.
 *
 * Registration stays one walk over `toolCategories` in declaration order. The deterministic
 * tool list the `tools/list` cache reasoning leans on falls out of that, so do not regroup
 * this by level or ceiling.
 */
export const registerAllTools = <C>(
	server: McpServer,
	client: C,
	toolCategories: Record<string, ToolDefinition<C>[]>,
	ceilings: ResolvedCeilings['ceilings'],
): string[] =>
	Object.entries(toolCategories).flatMap(([group, tools]) =>
		registerTools(server, client, tools, ceilingFor(ceilings, group)),
	)

/**
 * Says once per isolate what each group's ceiling is and what those ceilings withhold, so a
 * misconfiguration is visible in the log without reading code.
 *
 * The ceilings come from `env`, which module scope never sees on Workers, so this cannot be
 * the startup announcement it used to be — the caller invokes it from inside `fetch` behind a
 * once-flag instead. It stays a pure function of its arguments, and deliberately separate
 * from registration: since #40 the server is rebuilt per request, so a message logged as a
 * side effect of registering would repeat on every tool call.
 *
 * A refused config is deliberately not reported here: this runs once per isolate, and a
 * config that is broken right now deserves a line on every request it affects, so the caller
 * logs the refusal on the request path instead.
 */
export const announceWithheldTools = <C>(
	toolCategories: Record<string, ToolDefinition<C>[]>,
	resolved: ResolvedCeilings,
): void => {
	const ceilingsNamed = Object.entries(resolved.ceilings)
		.map(([group, ceiling]) => `${group}=${ceiling}`)
		.join(', ')

	const withheld = Object.entries(toolCategories).flatMap(([group, tools]) =>
		tools
			.filter((tool) => !isWithinCeiling(tool.level, ceilingFor(resolved.ceilings, group)))
			.map((tool) => tool.name),
	)

	const withholding =
		withheld.length > 0
			? `Withholding ${withheld.length} tools (${withheld.join(', ')})`
			: 'Withholding nothing'

	console.log(`Tool ceilings: ${ceilingsNamed}. ${withholding}`)
}

/**
 * Makes an app's `createTool`, deriving each handler's parameters from its schema.
 *
 * Curried on the client type because inference cannot recover it from a call site: the
 * handler's `client` parameter is an input, and an inline handler leaves it for the compiler
 * to fill in rather than stating a type inference could read. So each app binds the factory
 * once — `export const createTool = toolFactory<ZendeskClient>()` — and every tool definition
 * stays exactly as it would be with a concrete `createTool`, no type arguments at call sites.
 *
 * `level` is the tool's declared reach, and declaring it is a deliberate act of
 * classification — see `tool-ceilings.ts` for the vocabulary and `ToolDefinition` for why
 * there is no default. The type only admits the declarable subset, so `activate` is not a
 * value a tool can even attempt.
 *
 * The handler never restates its parameter type — it is inferred from `schema`, so the two
 * cannot drift apart. Adding a field to a shared schema immediately makes that field visible
 * to every handler spreading it, and naming a field the schema does not declare is now an
 * error rather than a parameter the server will never populate.
 *
 * The cast is the one place the specific parameter type is given up, and it is safe precisely
 * here: the compiler has just checked `handler` against `schema` for this call, and the MCP
 * server validates incoming arguments against that same schema before the handler ever runs.
 *
 * `successMessage` heads the record a write hands back — `'Ticket created successfully!'` above
 * the created ticket — and is applied on the success path only, so it cannot dress a failure up
 * as a success. A handler wording its whole answer, as `delete_ticket` does with an empty body
 * to report, returns the sentence as a string and leaves this unset: `withErrorHandling` passes
 * a string through untouched and never consults the message.
 */
export const toolFactory =
	<C>() =>
	<S extends ZodRawShape>(
		name: string,
		level: DeclarableLevel,
		description: string,
		schema: S,
		handler: (client: C, params: InferParams<S>) => Promise<unknown>,
		successMessage?: string,
	): ToolDefinition<C> => ({
		name,
		level,
		description,
		schema,
		handler: handler as ToolDefinition<C>['handler'],
		successMessage,
	})
