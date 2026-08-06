/**
 * Narrows a value to something whose properties can be read.
 *
 * The Zendesk client returns `unknown`, which is honest — it has no idea what came back —
 * but it means anything wanting to look inside a response body has to establish that there
 * is an inside first. This is that step, and it is deliberately the whole of it: it proves
 * the value is a non-null object and says nothing about which keys are present, so every
 * property read off the result is still `unknown` and still has to be checked.
 *
 * `typeof null === 'object'` is the reason for the second clause.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null
