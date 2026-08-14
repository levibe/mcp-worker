import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer, type ServerOptions } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { createGoogleHandler, type GoogleHandlerSecrets } from './oauth/google-handler'
import type { ToolDefinition } from './registry/types'
import { announceWithheldTools, registerAllTools } from './registry/tool-registry'
import { resolveCeilings, type ResolvedCeilings } from './registry/tool-ceilings'

// The registry surface rides along on the root entry: a consumer of the factory always needs
// toolFactory and the level types, so it should not need a second import path to reach them.
export * from './registry'

export interface McpWorkerOptions<TEnv extends GoogleHandlerSecrets, C> {
	/** Passed to `new McpServer(...)` — rebuilt per request, never hoisted, by construction. */
	server: { name: string; version: string; description?: string }
	toolCategories: Record<string, ToolDefinition<C>[]>
	/** Built fresh per request. Must be cheap: configuration only, no connections. */
	createClient: (env: TEnv) => C
	/** Where the raw ceilings config lives, e.g. `(env) => env.TOOL_CEILINGS`. */
	ceilingsFrom: (env: TEnv) => unknown
	/** The approval dialog's product identity — see `GoogleHandlerOptions`. */
	approvalDialog: { name: string; description?: string; logo?: string }
	/**
	 * Ninety days unless the deployment says otherwise. How long a refresh token lives is a
	 * risk-posture decision — the token is the only revocation there is for a server whose
	 * upstream identity is never re-checked — so the default is a moderate middle between the
	 * OAuth provider library's thirty days (a re-auth every month) and a deployment-argued
	 * year. State your own number when your deployment has its own argument —
	 * zendesk-mcp-cloudflare does, next to the year-long figure in its own index.ts.
	 */
	refreshTokenTTL?: number
	/**
	 * Which path the MCP endpoint answers on. Default '/mcp'. Whatever is passed reaches two
	 * places that must agree — the `apiHandlers` key on the OAuth provider and
	 * `createMcpHandler`'s own exact route match — because a route half-applied 404s the endpoint.
	 *
	 * An array mounts the same endpoint on several paths at once. The usual reason is a dedicated
	 * mcp.* subdomain, where the '/mcp' suffix is redundant: `['/mcp', '/']` keeps the canonical
	 * path working while also answering at the bare subdomain root, so a client can be pointed at
	 * the subdomain itself. The provider matches '/' exactly rather than as a prefix, so a root
	 * mount does not shadow '/authorize', '/token', '/register' or the OAuth metadata.
	 */
	route?: string | string[]
	/**
	 * Passed through to `createMcpHandler`. A request with no Origin header always passes, so
	 * this only decides which browsers may call the endpoint — the default permits localhost
	 * plus the worker's own workers.dev hostname, and a custom domain therefore allows
	 * localhost and nothing else. Widen it one hostname at a time, never with a wildcard.
	 */
	allowedOriginHostnames?: string[]
	/**
	 * Five minutes on `tools/list` unless the deployment says otherwise. The TTL is the only
	 * bound on staleness there is, because nothing here can tell a client the list has
	 * changed — so read the number as an answer to "how long may a client go on offering a
	 * tool we have removed" before raising it. `private` because the only benefit available
	 * is a client not re-fetching its own list.
	 */
	cacheHints?: ServerOptions['cacheHints']
	/**
	 * Four hundred days, and it exists only to stay out of the way of the grant. A grant is
	 * swept once the client it was issued against is gone, and this TTL is stamped at
	 * registration and never rolls forward on use, so whichever of the two is shorter is what
	 * actually bounds a session. Left at the library's ninety-day default it would end every
	 * session at ninety days no matter what the grant said — the same outage, arriving from
	 * the side nobody was looking at.
	 *
	 * The four hundred is sized over the longest grant a deployment argues, not this
	 * package's ninety-day default: zendesk-mcp-cloudflare runs a year-long grant, and the
	 * month of headroom above it is sized to how clients are actually minted rather than to
	 * anything in the spec — a connector registers a fresh client each time it connects, so a
	 * client and the grant issued against it are minutes apart in practice. It would not
	 * cover a client reused for a new grant much later, which is worth re-deriving rather
	 * than assuming if a client ever starts being long-lived.
	 */
	clientRegistrationTTL?: number
}

/**
 * Builds the whole Worker: the OAuth provider around a streamable-HTTP MCP endpoint, with
 * per-group tool ceilings resolved from config on every request. Returns the instance to
 * `export default`.
 *
 * Two invariants live in here so that no consumer can reconstruct them wrongly, because both
 * fail silently under local testing and loudly under load:
 *
 * - The `McpServer` and the client are rebuilt for every request, inside the handler where
 *   nobody can hoist them. A shared instance answers sequential requests perfectly correctly;
 *   it comes apart only under concurrency, because closing the server at the end of one
 *   exchange aborts every handler still in flight on it and those requests never settle.
 *
 * - The withheld-tools announcement runs once per isolate, from inside `fetch`, because the
 *   ceilings come from `env` and module scope never sees `env` on Workers. The factory is
 *   called once at the consumer's module scope, so this closure's lifetime is the isolate's.
 *   Two first requests racing can double-log; that is benign and not worth a lock.
 */
export const createMcpWorker = <TEnv extends GoogleHandlerSecrets, C>(
	options: McpWorkerOptions<TEnv, C>,
): OAuthProvider<TEnv> => {
	let announced = false

	const routes = Array.isArray(options.route) ? options.route : [options.route ?? '/mcp']
	const cacheHints = options.cacheHints ?? {
		'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
	}

	const createServer = (env: TEnv, ceilings: ResolvedCeilings['ceilings']) => {
		const server = new McpServer(options.server, { cacheHints })

		registerAllTools(server, options.createClient(env), options.toolCategories, ceilings)

		return server
	}

	/**
	 * The wrapper is not ceremony. `OAuthProvider` calls `fetch(request, env, ctx)` while the
	 * handler's own `fetch` takes `(request, options)`, so passing the handler straight through
	 * would land `env` in the options argument. Calling the handler itself, which does take the
	 * three, is what keeps `ctx.props` reaching `getMcpAuthContext()` inside a tool.
	 */
	const makeMcpHandler = (handlerRoute: string) => ({
		fetch: (request: Request, env: TEnv, ctx: ExecutionContext): Promise<Response> => {
			// Resolved once per request, like the server itself — it is a small parse of a small
			// object, and per-request is what keeps a config-only deploy taking effect without a
			// special path. Malformed or missing config fails closed to read on every group.
			const resolved = resolveCeilings(
				options.ceilingsFrom(env),
				Object.keys(options.toolCategories),
			)

			// The refusal is logged on every request it affects, not once behind the flag below:
			// failing closed is otherwise invisible, and one line per affected request is the
			// representative loudness for a config that is broken right now.
			if (resolved.error) {
				console.error(`TOOL_CEILINGS refused (${resolved.error}); every group falls closed to read`)
			}

			if (!announced) {
				announced = true
				announceWithheldTools(options.toolCategories, resolved)
			}

			return createMcpHandler(() => createServer(env, resolved.ceilings), {
				route: handlerRoute,
				...(options.allowedOriginHostnames !== undefined
					? { allowedOriginHostnames: options.allowedOriginHostnames }
					: {}),
			})(request, env, ctx)
		},
	})

	return new OAuthProvider({
		apiHandlers: Object.fromEntries(routes.map((r) => [r, makeMcpHandler(r)])),
		authorizeEndpoint: '/authorize',
		clientRegistrationEndpoint: '/register',
		defaultHandler: createGoogleHandler({ server: options.approvalDialog }),
		clientRegistrationTTL: options.clientRegistrationTTL ?? 34_560_000,
		refreshTokenTTL: options.refreshTokenTTL ?? 7_776_000,
		tokenEndpoint: '/token',
	})
}
