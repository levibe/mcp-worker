import type { ZodRawShape } from 'zod'

/**
 * Refuses an update that names no field to change, rather than sending it to Zendesk.
 *
 * Zendesk accepts an empty update, changes nothing and answers with the unchanged record, so
 * the call reads back as a success. A model that sent no fields meant to send some, and the
 * one thing that helps it is being told so — which is why this throws rather than returning
 * early with a worded response. `withErrorHandling` is what turns the throw into `isError`,
 * and a handler building its own response would bury that. See its comment for the cost.
 *
 * The field names come from the schema rather than a written-out list, for the same reason
 * every handler's parameters are inferred from one: a field added to the update shape appears
 * in this message without anyone remembering to add it.
 */
export const requireChanges = (
	toolName: string,
	schema: ZodRawShape,
	changes: Record<string, unknown>
): void => {
	if (Object.keys(changes).length > 0) return

	throw new Error(
		`${toolName} needs at least one field to change: ${Object.keys(schema).join(', ')}.`
	)
}
