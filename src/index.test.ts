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

// The factory subclasses the provider to scope the protected-resource metadata to the routes it
// mounts, so the mock has to be constructible and carry a `fetch` on its prototype for `super.fetch`
// to resolve. The constructor is still a spy, so the config it was handed is still readable, and
// the delegated response is identifiable by its body — which is how the tests below tell a request
// the factory passed through from one it answered itself.
vi.mock('@cloudflare/workers-oauth-provider', () => {
	const Provider = vi.fn()
	Provider.prototype.fetch = vi.fn(async () => new Response('delegated'))
	return { default: Provider }
})
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
	// first test's config forever. Cleared by hand for that reason — the prototype fetch
	// included, so a future assertion on delegation is not order-dependent.
	providerMock.mockClear()
	vi.mocked(OAuthProvider.prototype.fetch).mockClear()
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

	// A dedicated mcp.* subdomain makes the '/mcp' path redundant, so a deployment can mount the
	// endpoint at several paths at once — typically the canonical '/mcp' plus a bare '/' alias, so
	// the subdomain root is itself a working MCP endpoint. Each path needs its own apiHandlers key
	// and its own inner route, or the half it missed 404s.
	it('mounts an apiHandler at every route when given an array', () => {
		createMcpWorker(workerOptions({ route: ['/mcp', '/'] }))

		expect(Object.keys(providerConfig().apiHandlers)).toEqual(['/mcp', '/'])
	})

	it('hands each route its own inner route so the exact-match agrees', async () => {
		createMcpWorker(workerOptions({ route: ['/mcp', '/'] }))

		await fetchOnce('/')

		const [, handlerOptions] = handlerMock.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
		]
		expect(handlerOptions.route).toBe('/')
	})

	it('rejects an empty route array rather than silently dropping the endpoint', () => {
		expect(() => createMcpWorker(workerOptions({ route: [] }))).toThrow(TypeError)
	})

	// The provider returns the first apiHandler whose route prefix-matches (every route but '/',
	// which it matches exactly), so a prefix offered before the longer path it prefixes would
	// shadow it — the request lands on the prefix's handler, whose inner exact-match then 404s
	// the longer path. Offering the more specific route first is what stops that.
	it('orders overlapping routes most-specific-first so a prefix cannot shadow', () => {
		createMcpWorker(workerOptions({ route: ['/mcp', '/mcp/tools'] }))

		expect(Object.keys(providerConfig().apiHandlers)).toEqual(['/mcp/tools', '/mcp'])
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

/**
 * The provider serves an RFC 9728 document at every path under the well-known prefix, deriving the
 * `resource` it advertises from the path it was asked at — so left alone it advertises the bare
 * origin at the path-less URL, a resource a worker mounted only at '/mcp' serves nothing at. These
 * pin the scoping that stops that: a document is served for a mounted route and refused everywhere
 * else, and everything that is not a metadata request reaches the provider untouched.
 */
describe('the protected-resource metadata', () => {
	const request = (
		path: string,
		over: Partial<McpWorkerOptions<StubEnv, StubClient>> = {},
		headers: Record<string, string> = {},
	) =>
		createMcpWorker(workerOptions(over)).fetch(
			new Request(`http://localhost${path}`, { headers }),
			env,
			{} as ExecutionContext,
		)

	it('refuses the path-less document, which names a resource nothing is mounted at', async () => {
		const response = await request('/.well-known/oauth-protected-resource')

		expect(response.status).toBe(404)
		// A cached refusal would outlive a config change that mounts '/', so it is uncacheable.
		expect(response.headers.get('Cache-Control')).toBe('no-store')
	})

	it('refuses it with a trailing slash too, which names the same bare origin', async () => {
		const response = await request('/.well-known/oauth-protected-resource/')

		expect(response.status).toBe(404)
	})

	it('serves the document for the route it does mount', async () => {
		const response = await request('/.well-known/oauth-protected-resource/mcp')

		expect(await response.text()).toBe('delegated')
	})

	// A deployment that mounts the root really does serve the bare origin, so the document naming
	// it is honest there — the refusal is about what is mounted, not about the path-less shape.
	it('serves the path-less document when the origin is itself a mounted route', async () => {
		const response = await request('/.well-known/oauth-protected-resource', {
			route: ['/mcp', '/'],
		})

		expect(await response.text()).toBe('delegated')
	})

	it('follows the configured route rather than a hardcoded /mcp', async () => {
		const served = await request('/.well-known/oauth-protected-resource/api/mcp', {
			route: '/api/mcp',
		})
		const refused = await request('/.well-known/oauth-protected-resource/mcp', {
			route: '/api/mcp',
		})

		expect(await served.text()).toBe('delegated')
		expect(refused.status).toBe(404)
	})

	it('leaves every other request to the provider', async () => {
		const response = await request('/authorize')

		expect(await response.text()).toBe('delegated')
	})

	// Without the echo a browser client reads a CORS failure rather than the 404 the server sent,
	// which is a worse answer to the same question.
	it('echoes the Origin on the refusal, and sends no CORS header without one', async () => {
		const withOrigin = await request(
			'/.well-known/oauth-protected-resource',
			{},
			{ Origin: 'https://app.example.com' },
		)
		const withoutOrigin = await request('/.well-known/oauth-protected-resource')

		expect(withOrigin.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
		// The echo varies by requester, so a shared cache must not replay one origin's answer to
		// another.
		expect(withOrigin.headers.get('Vary')).toBe('Origin')
		expect(withoutOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull()
	})

	// A browser preflights the GET (the MCP auth spec's MCP-Protocol-Version header is not
	// safelisted), and a preflight must succeed for the GET to be sent at all — so OPTIONS reaches
	// the provider even on a refused path, and the refusal itself arrives on the GET.
	it('leaves OPTIONS preflights to the provider even on a refused path', async () => {
		const response = await createMcpWorker(workerOptions()).fetch(
			new Request('http://localhost/.well-known/oauth-protected-resource', {
				method: 'OPTIONS',
				headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET' },
			}),
			env,
			{} as ExecutionContext,
		)

		expect(await response.text()).toBe('delegated')
	})
})
