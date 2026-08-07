/**
 * Registration is the only thing standing between a write tool and a client, so what it
 * publishes is a security boundary rather than a detail of how tools are wired together.
 * A tool that is defined but never registered cannot be called; one that slips through can.
 *
 * Everything here is pure registry behavior, driven through a stub client — the registry
 * never calls into the client, it only binds it. The tests that hold a deployment's shipped
 * surface still — the pinned inventory, and the announcement over the real manifest — stay
 * with the consumer (zendesk-mcp-cloudflare keeps them in `src/tool-ceilings-config.test.ts`),
 * because they are coupled to its wrangler.jsonc and `toolCategories` rather than to the
 * registry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpToolResponse, ToolDefinition } from './types'
import type { DeclarableLevel } from './tool-ceilings'
import {
	announceWithheldTools,
	registerAllTools,
	registerTools,
	toolFactory,
} from './tool-registry'

/** The registry never calls into the client — it only binds it — so a marker type serves. */
type StubClient = { readonly kind: 'stub' }

const stubClient: StubClient = { kind: 'stub' }

const createTool = toolFactory<StubClient>()

const stubServer = () => ({ registerTool: vi.fn() })

type StubbedServer = ReturnType<typeof stubServer>

/** A `delete` ceiling publishes everything, for the tests where publication is not the subject. */
const register = (
	server: StubbedServer,
	tools: ToolDefinition<StubClient>[],
	ceiling: DeclarableLevel = 'delete'
) => registerTools(server as unknown as McpServer, stubClient, tools, ceiling)

const publishedBy = (server: StubbedServer): string[] =>
	server.registerTool.mock.calls.map(([name]) => name as string)

/** The wrapped handler the server was given, which is what a client's call actually runs. */
const handlerRegisteredBy = (server: StubbedServer): (() => Promise<McpToolResponse>) => {
	const [, , handler] = server.registerTool.mock.calls[0] as unknown as [
		string,
		unknown,
		() => Promise<McpToolResponse>,
	]

	return handler
}

const textOf = (response: McpToolResponse) => response.content[0].text

/** A tool of the given level that does nothing, since only its level decides its fate here. */
const levelledTool = (name: string, level: DeclarableLevel = 'read') =>
	createTool(name, level, `The ${name} tool`, {}, async () => ({}))

describe('registerTools', () => {
	it('publishes a tool whose level sits at or under the ceiling', () => {
		const server = stubServer()

		register(
			server,
			[levelledTool('list_macros', 'read'), levelledTool('create_macro', 'stage')],
			'stage'
		)

		expect(publishedBy(server)).toEqual(['list_macros', 'create_macro'])
	})

	it('withholds a tool whose level sits above the ceiling', () => {
		const server = stubServer()

		register(
			server,
			[levelledTool('create_ticket', 'write'), levelledTool('delete_ticket', 'delete')],
			'stage'
		)

		expect(server.registerTool).not.toHaveBeenCalled()
	})

	// The order is the vocabulary's one load-bearing fact — read < stage < write < delete —
	// so it is pinned pair by pair rather than trusted to the rank table staying sorted.
	it.each([
		['read', ['read']],
		['stage', ['read', 'stage']],
		['write', ['read', 'stage', 'write']],
		['delete', ['read', 'stage', 'write', 'delete']],
	] as const)('a %s ceiling publishes exactly the levels under it', (ceiling, published) => {
		const server = stubServer()
		const tools = (['read', 'stage', 'write', 'delete'] as const).map((level) =>
			levelledTool(`${level}_tool`, level)
		)

		register(server, tools, ceiling)

		expect(publishedBy(server)).toEqual(published.map((level) => `${level}_tool`))
	})

	it('reports the withheld names back to the caller', () => {
		const withheld = register(
			stubServer(),
			[
				levelledTool('get_macro', 'read'),
				levelledTool('delete_macro', 'delete'),
				levelledTool('create_ticket', 'write'),
			],
			'stage'
		)

		expect(withheld).toEqual(['delete_macro', 'create_ticket'])
	})

	// A description reaching the server used to depend on argument position: SDK v1 chose an
	// overload by shape, so passing the schema one place early silently selected the one taking
	// no description, and every client had to choose between 36 tools by name alone. v2 names
	// the field instead, so that particular slip cannot recur — this stays because the property
	// it was protecting is what matters, not the mechanism that once broke it.
	it('passes the description along, not just the name and the schema', () => {
		const server = stubServer()
		const tool = levelledTool('list_macros')

		register(server, [tool])

		expect(server.registerTool).toHaveBeenCalledWith(
			'list_macros',
			expect.objectContaining({ description: tool.description }),
			expect.any(Function)
		)
	})

	// v2 deprecates handing `registerTool` a bare `{ field: z.string() }` record, so the registry
	// wraps every shape before passing it on. Asserting the schema parses rather than asserting
	// on its internals keeps this from pinning how Zod represents an object.
	it('wraps the shape into a schema the server can validate against', () => {
		const server = stubServer()
		const tool = createTool(
			'list_macros',
			'read',
			'List macros',
			{ page: z.number().optional() },
			async () => ({})
		)

		register(server, [tool])

		const [, config] = server.registerTool.mock.calls[0] as unknown as [
			string,
			{ inputSchema: z.ZodType },
		]

		expect(config.inputSchema.parse({ page: 2 })).toEqual({ page: 2 })
	})

	it('wraps the handler so a failed call reaches the client as an error response', async () => {
		const server = stubServer()
		const tool = createTool('list_macros', 'read', 'List macros', {}, async () => {
			throw new Error('Zendesk API Error: 503 - unavailable')
		})

		register(server, [tool])

		await expect(handlerRegisteredBy(server)()).resolves.toEqual({
			content: [{ type: 'text', text: 'Error: Zendesk API Error: 503 - unavailable' }],
			isError: true,
		})
	})

	// A write's confirmation travels on the definition so that registration can apply it, since
	// registration owns the only wrapper that turns a result into a response. A handler wording
	// its own would be wrapped again on the way out — #28.
	it('heads the result with the success message the definition carries', async () => {
		const server = stubServer()
		const created = { macro: { id: 42 } }
		const tool = createTool(
			'create_macro',
			'stage',
			'Create a macro',
			{},
			async () => created,
			'Macro created successfully!'
		)

		register(server, [tool])

		expect(textOf(await handlerRegisteredBy(server)())).toBe(
			`Macro created successfully!\n\n${JSON.stringify(created)}`
		)
	})

	// The half of #28 that mattered: a rejected write has to arrive as a failure. The message is
	// applied on the success path only, so carrying one cannot dress an error up as a success.
	it('reports a failed write as an error rather than heading it as a success', async () => {
		const server = stubServer()
		const tool = createTool(
			'create_macro',
			'stage',
			'Create a macro',
			{},
			async () => {
				throw new Error('Zendesk API Error: 422 - RecordInvalid')
			},
			'Macro created successfully!'
		)

		register(server, [tool])
		const response = await handlerRegisteredBy(server)()

		expect(response.isError).toBe(true)
		expect(textOf(response)).toBe('Error: Zendesk API Error: 422 - RecordInvalid')
	})
})

describe('registerAllTools', () => {
	// The runtime backstop for a category that lands in toolCategories before the shipped
	// TOOL_CEILINGS names it. A consumer's config test fails its validate on that drift; this
	// is what the deployed worker does in the meantime, and it has to fail closed rather than
	// open.
	it('treats a group the ceilings never named as read-only', () => {
		const server = stubServer()

		registerAllTools(
			server as unknown as McpServer,
			stubClient,
			{ widgets: [levelledTool('list_widgets', 'read'), levelledTool('create_widget', 'stage')] },
			{}
		)

		expect(publishedBy(server)).toEqual(['list_widgets'])
	})
})

describe('announceWithheldTools', () => {
	// Created in a beforeEach because restoreMocks undoes it between tests, and one made at
	// module scope would be gone before the first test ran.
	let log: MockInstance<typeof console.log>
	let error: MockInstance<typeof console.error>

	beforeEach(() => {
		log = vi.spyOn(console, 'log').mockImplementation(() => {})
		error = vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('says so when the ceilings withhold nothing', () => {
		announceWithheldTools(
			{ reads: [levelledTool('list_macros', 'read')] },
			{ ceilings: { reads: 'read' } }
		)

		expect(log).toHaveBeenCalledWith(expect.stringContaining('Withholding nothing'))
		expect(error).not.toHaveBeenCalled()
	})

	// The same read-only backstop registerAllTools applies, so the announcement never claims
	// more is published than registration would actually publish.
	it('counts a group the ceilings never named as withheld above read', () => {
		announceWithheldTools(
			{ widgets: [levelledTool('list_widgets', 'read'), levelledTool('create_widget', 'stage')] },
			{ ceilings: {} }
		)

		expect(log).toHaveBeenCalledWith(expect.stringContaining('create_widget'))
	})
})
