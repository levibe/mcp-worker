/**
 * The factory's job is wiring, so what these pin is the wiring's two silent invariants — a
 * fresh server and client per request, the ceilings announcement once per isolate — plus the
 * defaults and pass-throughs a consumer's one config call relies on. The OAuth provider and
 * the MCP handler are mocked at the module seam: what they do is theirs to test, and what
 * this file asserts is exactly what they were handed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { createMcpWorker, type McpWorkerOptions } from './index'
import { toolFactory } from './registry/tool-registry'

vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: vi.fn() }))
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }))

type StubClient = { readonly kind: 'stub' }

interface StubEnv {
	COOKIE_ENCRYPTION_KEY: string
	GOOGLE_CLIENT_ID: string
	GOOGLE_CLIENT_SECRET: string
	TOOL_CEILINGS?: unknown
}

const env: StubEnv = {
	COOKIE_ENCRYPTION_KEY: 'key',
	GOOGLE_CLIENT_ID: 'id',
	GOOGLE_CLIENT_SECRET: 'secret',
	TOOL_CEILINGS: { widgets: 'read' },
}

const createTool = toolFactory<StubClient>()

const toolCategories = {
	widgets: [createTool('list_widgets', 'read', 'List widgets', {}, async () => ({}))],
}

const workerOptions = (
	over: Partial<McpWorkerOptions<StubEnv, StubClient>> = {},
): McpWorkerOptions<StubEnv, StubClient> => ({
	server: { name: 'Widget Server', version: '1.0.0' },
	toolCategories,
	createClient: vi.fn(() => ({ kind: 'stub' as const })),
	ceilingsFrom: (e) => e.TOOL_CEILINGS,
	approvalDialog: { name: 'Widget MCP' },
	...over,
})

const providerMock = vi.mocked(OAuthProvider)
const handlerMock = vi.mocked(createMcpHandler)

/** The config object the factory handed the OAuth provider. */
const providerConfig = () =>
	providerMock.mock.calls[0][0] as unknown as Record<string, unknown> & {
		apiHandlers: Record<
			string,
			{ fetch: (request: Request, env: StubEnv, ctx: ExecutionContext) => Promise<Response> }
		>
	}

/** Every server the per-request factory built, in order. */
let servers: unknown[]

const fetchOnce = (route = '/mcp') =>
	providerConfig().apiHandlers[route].fetch(
		new Request(`http://localhost${route}`),
		env,
		{} as ExecutionContext,
	)

beforeEach(() => {
	// restoreMocks in vitest.config.ts does not reach mocks created inside a vi.mock factory,
	// so their call history would accumulate across tests and providerConfig() would read the
	// first test's config forever. Cleared by hand for that reason.
	providerMock.mockClear()
	handlerMock.mockClear()
	servers = []
	// The mock plays the one part of the real handler this file depends on: it invokes the
	// server factory once per call, the way the real one builds a server per request.
	handlerMock.mockImplementation(((serverFactory: () => unknown) => {
		servers.push(serverFactory())
		return vi.fn(async () => new Response(null))
	}) as unknown as typeof createMcpHandler)
	vi.spyOn(console, 'log').mockImplementation(() => {})
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('per-request construction', () => {
	it('builds a fresh server and a fresh client for every request', async () => {
		const options = workerOptions()
		createMcpWorker(options)

		await fetchOnce()
		await fetchOnce()

		expect(servers).toHaveLength(2)
		expect(servers[0]).not.toBe(servers[1])
		expect(options.createClient).toHaveBeenCalledTimes(2)
	})
})

describe('the ceilings on the request path', () => {
	it('announces them once per isolate, not once per request', async () => {
		createMcpWorker(workerOptions())

		await fetchOnce()
		await fetchOnce()

		const announcements = vi
			.mocked(console.log)
			.mock.calls.filter(([line]) => String(line).includes('Tool ceilings'))
		expect(announcements).toHaveLength(1)
	})

	it('logs a refused config on every request it affects', async () => {
		createMcpWorker(workerOptions({ ceilingsFrom: () => undefined }))

		await fetchOnce()
		await fetchOnce()

		const refusals = vi
			.mocked(console.error)
			.mock.calls.filter(([line]) => String(line).includes('falls closed to read'))
		expect(refusals).toHaveLength(2)
	})
})

describe('the provider config', () => {
	it('defaults the TTLs and the route the way the docs say', () => {
		createMcpWorker(workerOptions())

		const config = providerConfig()
		expect(config.refreshTokenTTL).toBe(7_776_000)
		expect(config.clientRegistrationTTL).toBe(34_560_000)
		expect(Object.keys(config.apiHandlers)).toEqual(['/mcp'])
		expect(config.authorizeEndpoint).toBe('/authorize')
		expect(config.clientRegistrationEndpoint).toBe('/register')
		expect(config.tokenEndpoint).toBe('/token')
	})

	it('lets a deployment state its own TTLs', () => {
		createMcpWorker(
			workerOptions({
				refreshTokenTTL: 31_536_000,
				clientRegistrationTTL: 1_000,
				cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } },
			}),
		)

		const config = providerConfig()
		expect(config.refreshTokenTTL).toBe(31_536_000)
		expect(config.clientRegistrationTTL).toBe(1_000)
	})

	it('hands the provider a default handler that answers fetch', () => {
		createMcpWorker(workerOptions())

		const handler = providerConfig().defaultHandler as { fetch?: unknown }
		expect(typeof handler.fetch).toBe('function')
	})
})

describe('the route and the origin allowlist', () => {
	// A route half-applied 404s the endpoint, so the same string has to reach both the
	// apiHandlers key and the handler's own route match.
	it('uses a custom route in both places it must agree with itself', async () => {
		createMcpWorker(workerOptions({ route: '/api/mcp' }))

		expect(Object.keys(providerConfig().apiHandlers)).toEqual(['/api/mcp'])

		await fetchOnce('/api/mcp')

		const [, handlerOptions] = handlerMock.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
		]
		expect(handlerOptions.route).toBe('/api/mcp')
	})

	it('passes allowedOriginHostnames through when given', async () => {
		createMcpWorker(workerOptions({ allowedOriginHostnames: ['app.example.com'] }))

		await fetchOnce()

		const [, handlerOptions] = handlerMock.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
		]
		expect(handlerOptions.allowedOriginHostnames).toEqual(['app.example.com'])
	})

	// Absent rather than undefined, so the handler's own default decides — an explicit
	// `undefined` would still be an own property, and whether a library reads `in` or `??`
	// is not something this wiring should have an opinion about.
	it('omits the key entirely when no allowlist was given', async () => {
		createMcpWorker(workerOptions())

		await fetchOnce()

		const [, handlerOptions] = handlerMock.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
		]
		expect('allowedOriginHostnames' in handlerOptions).toBe(false)
	})
})
