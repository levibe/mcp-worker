import type { z } from 'zod'
import type { DeclarableLevel } from './tool-ceilings'

/**
 * The MCP scaffolding types, kept apart from the Zendesk schemas because nothing in them is
 * Zendesk's: these are the shapes any server built on the registry shares, whatever client
 * its handlers drive.
 */

export interface McpToolResponse {
	[x: string]: unknown
	content: Array<{
		type: 'text'
		text: string
	}>
	isError?: boolean
}

/**
 * The parameters a handler receives, derived from its own Zod schema.
 *
 * Wrapping the shape and inferring through it is what the SDK itself does for a raw shape, so
 * the type a handler declares is exactly what the server will hand it at runtime — optional
 * fields included, since inference marks a key optional when its schema accepts `undefined`.
 */
export type InferParams<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>

/**
 * A registered tool, with its parameter type deliberately erased.
 *
 * Tools have differing parameter shapes but have to share one array, so the shape cannot
 * survive into this interface. `toolFactory` is what keeps the guarantee: it checks each
 * handler against its own schema before widening it to fit here.
 *
 * `C` is the client the handlers drive, and it is a parameter rather than a concrete type
 * because the registry itself never calls into the client — it only binds it. Each app names
 * its client once, where it binds `toolFactory`, and exports a bound alias for its tool
 * arrays to annotate with: the handler's `client` parameter is contravariant, so a bare
 * `ToolDefinition` naming no client could not accept handlers typed against a real one.
 *
 * `level` is the tool's declared reach — see `tool-ceilings.ts` for the vocabulary — and it is
 * required rather than defaulted, because a default is either fail-open or a silent withhold.
 * Whether a client is offered the tool is decided at registration, from this declaration and
 * the deployment's ceiling for the group, never from the tool's name.
 *
 * `successMessage` is how a write tool gets its worded confirmation without building a response
 * of its own — see `withErrorHandling` for why that matters.
 */
export interface ToolDefinition<C> {
	name: string
	level: DeclarableLevel
	description: string
	schema: z.ZodRawShape
	handler: (client: C, params: Record<string, unknown>) => Promise<unknown>
	successMessage?: string
}
