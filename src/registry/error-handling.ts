import type { McpToolResponse } from './types'

/**
 * `registerTools` is the only caller, and applies this to every handler exactly once. Do not
 * call it from inside a handler as well: a response wrapped twice is JSON-encoded as the text
 * of the outer one, and `isError` goes with it, so a failed call reports as a successful one.
 * A write's worded confirmation reaches this as `successMessage` on the tool definition.
 */
export const withErrorHandling =
	<T extends unknown[], R>(fn: (...args: T) => Promise<R>, successMessage?: string) =>
	async (...args: T): Promise<McpToolResponse> => {
		try {
			const result = await fn(...args)

			if (typeof result === 'string') {
				return {
					content: [{ type: 'text', text: result }],
				}
			}

			// For API responses, format as JSON. `JSON.stringify` answers `undefined` rather than a
			// string for a handler that resolved to nothing, so the parts are filtered rather than
			// concatenated: interpolating that into a template writes the word "undefined" into the
			// text, and using it as the text breaks the promise this response's own type makes.
			// A tool with nothing to report and nothing to say gets empty text, which is the honest
			// answer — a tool that wants to say something returns a string and leaves through the
			// branch above.
			// Annotated because `lib.d.ts` types `JSON.stringify` as returning a `string`, which
			// makes the check below look like dead code to anyone reading the types rather than
			// this comment. The overload telling the truth is the one taking a value that may not
			// be representable, and this is that case.
			// No indent argument, and that is a decision rather than an omission. The reader on
			// the other end of this text is a model, so two spaces a level buys legibility for
			// nobody and spends context on whitespace — a listing of a hundred nested tickets
			// pays for it many times over. Do not put `null, 2` back to make a response easier to
			// eyeball while debugging; read it through `jq` at the point you are debugging, and
			// leave what ships compact.
			const body: string | undefined = JSON.stringify(result)
			const text = [successMessage, body].filter((part) => part !== undefined).join('\n\n')

			return {
				content: [{ type: 'text', text }],
			}
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					},
				],
				isError: true,
			}
		}
	}
