# Implementation Plan: Extract `@levibe/mcp-worker` from zendesk-mcp-cloudflare

## Status and orchestration

This plan was written and adversarially critiqued in a zendesk-mcp-cloudflare planning session on 2026-08-05, and is committed here so implementation sessions in any of the three repos can read it. Each phase's GitHub issue carries its executable summary; this document carries the full design decisions behind them. **The issues and the project board are authoritative for status** (https://github.com/users/levibe/projects/7); the table below is a snapshot as of 2026-08-05.

| Phase                            | Repo                   | Issue                            | As of 2026-08-05                                      |
| -------------------------------- | ---------------------- | -------------------------------- | ----------------------------------------------------- |
| A: parameterize in place         | zendesk-mcp-cloudflare | levibe/zendesk-mcp-cloudflare#93 | Implemented; PR levibe/zendesk-mcp-cloudflare#95 open |
| B: scaffold, lift, publish 0.1.0 | mcp-worker             | #1                               | Blocked on PR 95 merging                              |
| C: adopt the package             | zendesk-mcp-cloudflare | levibe/zendesk-mcp-cloudflare#94 | Blocked on B                                          |
| Vendored-file typing             | mcp-worker             | #2                               | After B; independent of C                             |
| D: typeform rebuild              | typeform-mcp           | levibe/typeform-mcp#1            | Needs its own plan; implement after B                 |

Guidance for an implementation session:

- Run one session per phase, in that phase's repo. Read this document and the phase's issue before writing code; the repo's CLAUDE.md rationale is load-bearing, not commentary.
- The Phase A discipline holds in every phase: the suite green at every commit, and error-message assertion strings treated as behavior, never as tests to update.
- Phase B's lift must be a pure copy of the post-Phase-A modules. If something needs editing beyond import paths (and the two sanctioned edits in the issue), stop and fix it in the zendesk repo first.
- The B2 gate is `pnpm pack` plus a tarball install into zendesk on a scratch branch, never `pnpm link` (two-zod topology; see D9).
- A session's last act is updating its issue: check the boxes, comment what shipped and what was deferred. The next session starts from that, not from a transcript.

## Context

zendesk-mcp-cloudflare contains roughly 1,900 lines of MCP-server infrastructure that is either already generic or generic modulo one type parameter and a handful of hoisted literals: the tool registry and ceilings system, the response wrapper, the retrying HTTP transport inside `ZendeskClient`, the Google OAuth handler with its nonce-cookie CSRF binding, the vendored approval-dialog helper, and the `index.ts` wiring that encodes two hard-won invariants (a fresh `McpServer` per request; `announceWithheldTools` once per isolate inside `fetch`).

typeform-mcp is a 3-commit stale fork of the _old_ zendesk-mcp (McpAgent/Durable Object + `/sse`, MCP SDK 1.13.1, oauth-provider 0.0.5, zod 3, pre-ceilings registry, no retry, no tests, no CI, dead Zendesk search-response code still in its tree). It is effectively a rebuild. Extracting the infrastructure into one `@levibe`-scoped package makes that rebuild a configuration exercise instead of a second copy that drifts.

Four phases: **A** refactor in place in the zendesk repo (parameterize, compose, hoist) with the full test suite green at every commit; **B** scaffold the package repo and lift the parameterized modules plus their tests, publish 0.1.0; **C** swap zendesk's imports to the package; **D** (separate follow-up plan) rebuild typeform on it — validated on paper here only.

Base on `main` once PR #92 (`20-permission-levels`) merges. Each phase that lands in a repo gets its own GitHub issue and a `{issue-id}-{short-desc}` branch per house convention.

## Design Decisions

### D1. One package, standalone repo, subpath exports — `@levibe/mcp-worker`

One package rather than three (registry / http / oauth) because every extra package multiplies the 7-day `minimumReleaseAge` cooldown pins and the release ceremony, the modules share a peer surface (zod crosses every boundary) and a release cadence, and no consumer plausibly wants `oauth` at a different version than `registry`.

Name: `@levibe/mcp-worker`, repo `levibe/mcp-worker`. It says what it is: an MCP server packaged as a Cloudflare Worker. `workers-mcp` on npm is Cloudflare's (typeform-mcp literally depends on it today), so the near-collision of an unscoped-sounding name would be actively misleading; the scope plus a different word order keeps them distinct.

Subpath exports keep dependency reach honest:

```json
"exports": {
	".":          { "types": "./dist/index.d.ts",          "import": "./dist/index.js" },
	"./registry": { "types": "./dist/registry/index.d.ts", "import": "./dist/registry/index.js" },
	"./http":     { "types": "./dist/http/index.d.ts",     "import": "./dist/http/index.js" },
	"./oauth":    { "types": "./dist/oauth/index.d.ts",    "import": "./dist/oauth/index.js" }
}
```

- `.` — the `createMcpWorker` factory (needs oauth-provider, agents, the MCP server package) plus convenience re-exports of `./registry`.
- `./registry` — `toolFactory`, `ToolDefinition`, `registerTools`, `registerAllTools`, `announceWithheldTools`, `resolveCeilings`, `isWithinCeiling`, `ToolLevel`, `DeclarableLevel`, `ResolvedCeilings`, `withErrorHandling`, `McpToolResponse`, `InferParams`, `requireChanges`. Deps: zod plus `@modelcontextprotocol/server` (types only). (`isRecord` is deliberately not exported: `narrow.ts` stays in zendesk, whose response reshaping is its main user — see Phase C.)
- `./http` — `HttpClient`, `HttpRequestError`, `HttpClientOptions`. Zero runtime deps.
- `./oauth` — `createGoogleHandler`, `GoogleHandlerSecrets` (the type the `createMcpWorker` constraint names — consumers reference it), `GoogleHandlerEnv`, `Props`, `getUpstreamAuthorizeUrl`, `fetchUpstreamAuthToken`, the approval-dialog exports, the base64 helpers. Deps: hono plus `@cloudflare/workers-oauth-provider`.

### D2. Peer-dependency strategy

`peerDependencies`, never `dependencies`, for everything whose types or instances cross the boundary:

```json
"peerDependencies": {
	"@cloudflare/workers-oauth-provider": "^0.8.3",
	"@modelcontextprotocol/server": "^2.0.0",
	"agents": "^0.20.1",
	"hono": "^4.8.0",
	"zod": "^4.0.0"
},
"peerDependenciesMeta": {
	"@cloudflare/workers-oauth-provider": { "optional": true },
	"agents": { "optional": true },
	"hono": { "optional": true }
}
```

- zod is the non-negotiable one: `ZodRawShape` crosses the boundary in `ToolDefinition.schema` and `resolveCeilings` builds `strictObject`s; two zod instances break `instanceof` and inference. Required peer, `^4`.
- `@modelcontextprotocol/server` required (the `McpServer` type appears in `registerTools`' signature). Zendesk pins it exact (2.0.0); the package accepts `^2.0.0` and the app's exact pin governs resolution.
- `agents`, `hono`, oauth-provider are optional peers: a consumer using only `./registry` + `./http` needs none of them. Both known consumers install all five.
- All five duplicated in `devDependencies` so the package's own tests run.
- Ambient types: the package's tsconfig uses `"types": ["@cloudflare/workers-types"]` with workers-types as a devDependency only. Emitted `.d.ts` refers to `Request`/`Response`/`Headers`/`ExecutionContext` as bare globals, which resolve against the consumer's own generated `worker-configuration.d.ts` — the package forces nothing ambient on consumers.

### D3. Composition for the transport, app identity injected as options

The ~530 generic lines of `src/zendesk-client.ts` (error class, `parseRetryAfter`, `errorFromResponse`, retryable-status sets, six tuning constants, `causeChain`/`retryAfterFrom`, `describeRedirect`, `request`, `isRetryableError`, `requestWithRetry`, `send`) become an `HttpClient` class the app client wraps via `this.http`. Composition, not inheritance: the `which methods retry` prototype-walking test keys on `Object.getOwnPropertyNames(ZendeskClient.prototype)`; with the transport composed out, the `notAnApiCall` denylist shrinks from 9 entries to 3–4 and the test gets strictly stronger.

Two identity seams:

- **Error-message prefixes** (~17 assertions key on `'Zendesk API Error: '`): a `label` option (`'Zendesk'`) yields `${label} API Error: …`, `${label} answered … not valid JSON`, `${label} request failed: …` — byte-identical to today. The cross-host redirect message ends with an optional `redirectHint` sentence (zendesk passes `'If the Zendesk subdomain has moved, update ZENDESK_SUBDOMAIN.'`; typeform omits it).
- **The credential gate** ("Zendesk credentials not configured…" thrown as a _plain_ Error before the try so it is never retried): moves into the app's `authHeader` closure. `HttpClient.request` calls `authHeader()` first, outside the try, preserving the plain-Error-before-try discipline — including the `btoa`-on-a-non-Latin-1-token case, which now throws inside `authHeader` and stays non-retryable.

`ZendeskRequestError` becomes `HttpRequestError` (same shape). Zendesk re-exports it under the old name (`export { HttpRequestError as ZendeskRequestError }`) — same class, so `instanceof` assertions keep passing. Nothing in the tree asserts or classifies on `error.name`, so the `name` changing to `'HttpRequestError'` only reprefixes stack traces in logs; say so in the extraction commit. `@levibe/with-retry` stays untouched; it cannot express the single-deadline model or Retry-After overrides.

### D4. Registry goes generic via a curried factory, so tool files barely change

`ToolDefinition<C>` and a curried `toolFactory<C>()` rather than making every call site name the client type (an inline handler's `client` parameter can't drive inference of `C`). Each app binds it once:

```ts
// zendesk: src/tools/create-tool.ts (new)
export const createTool = toolFactory<ZendeskClient>()
export type ZendeskToolDefinition = ToolDefinition<ZendeskClient>
```

Every tool file changes two imports, both pointing at `'./create-tool'`: where `createTool` comes from, and the `ToolDefinition[]` annotation on its exported array, which becomes `ZendeskToolDefinition[]`. The bound alias is required, not a nicety: the handler's `client` parameter is contravariant, so no default type parameter could keep a bare `ToolDefinition` annotation compiling against `ZendeskClient`-typed handlers. `src/tools/index.ts` and the registry tests rebind the same way. Same pattern serves typeform.

### D5. `createMcpWorker` captures the invariants; the app supplies its identity and its risk posture

The factory owns both index.ts invariants: the `announced` once-per-isolate flag lives in the factory's closure (the factory is called once at consumer module scope, so closure scope = isolate scope), and per-request `McpServer` construction sits inside the handler where nobody can hoist it. `clientRegistrationTTL` (34_560_000) and the `tools/list` cache hint (`ttlMs: 300_000, cacheScope: 'private'`) become documented defaults.

`refreshTokenTTL` defaults to **90 days (7_776_000 seconds)** — the package's own argued position, not an inherited one. The underlying oauth-provider library defaults to 30 days, which forces a re-auth on every connector monthly; zendesk's one-year figure is justified in its index.ts from that deployment's shared-service-account model and is a per-deployment argument, not a package default. So the package sets a moderate middle with the reasoning next to it, and a consumer wanting a stronger or weaker posture states its own number — zendesk keeps passing 31_536_000 explicitly, with its justification comment staying next to the value it argues for.

The env constraint is on **secrets, not bindings**: `TEnv extends GoogleHandlerSecrets` (the four Google/cookie secrets plus optional `HOSTED_DOMAIN`). `OAUTH_PROVIDER` must not appear in the constraint — the wrangler-generated `Env` doesn't declare it and shouldn't, because the OAuth provider injects it per request. The factory and `createGoogleHandler` type their Hono bindings internally as `TEnv & { OAUTH_PROVIDER: OAuthHelpers }`, which is exactly the shape zendesk's google-handler.ts uses today.

`allowedOriginHostnames?: string[]` passes through to `createMcpHandler`. It is the one handler option a deployment legitimately needs (widening browser origins on a custom domain, one hostname at a time — documented in zendesk's CLAUDE.md), and adding it later costs a release plus a 7-day cooldown.

### D6. workers-oauth-utils moves as-is; the debt moves with it

The 712-line vendored file lifts with its `any` quarantine reproduced in the package's eslint config. One deliberate deviation: the five dead `ApprovalDialogOptions` fields (`cookieName`/`cookieSecret`/`cookieDomain`/`cookiePath`/`cookieMaxAge` — declared, never read) are deleted at lift time; a new public package should not advertise options that do nothing. Zendesk #3/#4 are already closed; the remaining debt is the `any` quarantine itself, so the package repo gets a fresh issue for typing the vendored file properly, opened during Phase B.

### D7. Package test suite and coverage ratchets

Tests lift with their modules (Phase A deliberately splits the wrangler.jsonc-coupled describes out so the lift is a pure copy). The package's `vitest.thresholds.ts` reproduces the per-file, no-global-floor convention:

| Package file                     | Threshold                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/registry/tool-ceilings.ts`  | 100 all four                                                                                                                                                             |
| `src/registry/tool-registry.ts`  | 100 all four                                                                                                                                                             |
| `src/registry/error-handling.ts` | 100 all four                                                                                                                                                             |
| `src/oauth/base64.ts`            | 100 all four                                                                                                                                                             |
| `src/oauth/google-handler.ts`    | 100 all four                                                                                                                                                             |
| `src/http/http-client.ts`        | measured at Phase A, rounded down (expect ≥95 branches)                                                                                                                  |
| `src/index.ts` (createMcpWorker) | pinned once factory tests exist (mock OAuthProvider/createMcpHandler; assert per-request server construction, once-per-isolate announce, refused-config log per request) |

Zendesk's `src/zendesk-client.ts` entry (branches: 90) is re-measured after the transport leaves; the branches it protects mostly depart. Adjust or drop with a commit message saying why.

### D8. CI / publish workflow for the package

Copy the with-retry shape, modernized: ci.yml (PR + push to main; pnpm via `packageManager`; Node from `.nvmrc` = **24** per the house rule that `.nvmrc` tracks the active LTS while `engines` carries the floor; `pnpm install --frozen-lockfile`; split validate steps; coverage comment job reusing the zendesk reporting action), publish.yml (`on: release: published`; permissions `contents: read, packages: write`; version-vs-tag check; `pnpm publish --no-git-checks`). Committed `.npmrc` with the two `@levibe` registry lines.

The package repo copies the house pnpm supply-chain settings (`minimumReleaseAge: 10080` strict, `allowBuilds`), which means its **own devDependencies need the same dated exclusion pins zendesk carries** — `agents@0.20.1`, `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/core@2.0.0`, `@modelcontextprotocol/client@2.0.0`, `@modelcontextprotocol/sdk@1.30.0`, `@cloudflare/workers-oauth-provider@0.8.3` — copied with their comments, including the trap that `agents@latest` silently resolves to 0.18.0, which predates `createMcpHandler`.

`package.json`: `packageManager: pnpm@10.32.1` (package convention; the zendesk app stays on 11.18.0), `engines.node >=22`, `files: ["dist", "LICENSE", "README.md"]`, `publishConfig: { access: "restricted", registry: "https://npm.pkg.github.com" }`, build `tsc && ts-add-js-extension --dir=dist`, `prepare: pnpm build`, `prepublishOnly: pnpm validate`. Keep a Changelog; `Bump version to X.Y.Z` commit; tag `vX.Y.Z`; Release fires publish. ESLint flat with oxfmt for formatting (tabs, no semicolons, single quotes), and eslint-config-prettier kept to switch off ESLint's own stylistic rules behind it; the package eslint config carries the workers-oauth-utils quarantine override and an internal `no-restricted-imports` guard on `withErrorHandling` (exempting `error-handling.ts`, `tool-registry.ts`, tests).

### D9. Avoiding the 7-day cooldown during B/C

- **The B2 verification gate is `pnpm pack` + tarball install, not `pnpm link`.** A linked package resolves imports through its own `node_modules`, which holds its devDependency copy of zod — so a linked run executes the exact two-zod topology D2 exists to prevent, and passes or fails in a configuration the published install never has. Build the tarball, install it into zendesk from the file path on a scratch branch, run the full suite. Tarball installs get peer resolution against the consumer, and a local file is outside `minimumReleaseAge`'s reach. `pnpm link` stays useful only for type-checking during the inner loop. Never commit a `link:`/`file:` specifier (CI uses `--frozen-lockfile`; Workers Builds clones one repo).
- For the Phase C PR (committed): publish 0.1.0 first, then add the exact pin `'@levibe/mcp-worker@0.1.0'` to `minimumReleaseAgeExclude` with a dated comment, per the existing self-expiring convention. Every package release consumed within 7 days needs its own pin; accepted friction.
- Verification caveat, first thing in Phase C: confirm pnpm can read publish-time metadata from GitHub Packages at all (scratch-branch install). If the metadata is absent and the check fails closed under `minimumReleaseAgeStrict: true`, the exact-pin exclusion is the escape hatch. Do not turn `minimumReleaseAgeStrict` off.
- `allowBuilds`: the package ships compiled JS; consumers never run its build. No new entries expected.

### D10. CLAUDE.md knowledge transfer

| Section (zendesk CLAUDE.md)                                                                    | Destination                                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "The server holds nothing between requests" (concurrency/teardown argument)                    | Package CLAUDE.md + `createMcpWorker` doc comment                                |
| "The tool list's TTL is the only staleness bound"                                              | Package CLAUDE.md, `cacheHints` option docs                                      |
| "A cookie is what binds the OAuth state, and a signature would not"                            | Package CLAUDE.md (oauth section); google-handler comments lift verbatim         |
| Ceilings vocabulary + Zendesk staging policy (dormant creates, article drafts, view audiences) | Vocabulary rationale to the package; the Zendesk policy sections stay in zendesk |
| Transport retry model (in-code comments)                                                       | Lift with the code; the comments are the spec                                    |
| Testing / Inspector / deployment sections                                                      | Stay in zendesk; package gets its own dev-commands section                       |

Package README additionally documents: the double-wrap trap with a copy-paste `no-restricted-imports` snippet for consumers targeting `['@levibe/mcp-worker', '@levibe/mcp-worker/*']`; the `errorFromResponse` single-construction-site invariant; why `activate` has no rank; the two-zod hazard; that the factory assumes a KV binding named exactly `OAUTH_KV` (convention, not typed — the OAuth provider library looks it up by name); the **companion `env.d.ts` pattern** — `wrangler types` generates an `Env` with bindings and vars only, so the consumer must hand-maintain an `env.d.ts` merging its secrets into `Env` (zendesk's is the model) or `TEnv extends GoogleHandlerSecrets` fails with a confusing error on day one; consumer setup (`.npmrc`, `GITHUB_PACKAGES_TOKEN` from Keychain locally, `PACKAGES_READ_TOKEN` in CI, Build-env token in Workers Builds).

## Exact New Signatures

### Registry (package `src/registry/`)

```ts
export interface ToolDefinition<C> {
	name: string
	level: DeclarableLevel
	description: string
	schema: ZodRawShape
	handler: (client: C, params: Record<string, unknown>) => Promise<unknown>
	successMessage?: string
}

export type InferParams<S extends ZodRawShape> = z.infer<z.ZodObject<S>>

/** Bind once per app: `export const createTool = toolFactory<ZendeskClient>()`. */
export const toolFactory =
	<C>() =>
	<S extends ZodRawShape>(
		name: string,
		level: DeclarableLevel,
		description: string,
		schema: S,
		handler: (client: C, params: InferParams<S>) => Promise<unknown>,
		successMessage?: string
	): ToolDefinition<C>

export const registerTools = <C>(
	server: McpServer, client: C, tools: ToolDefinition<C>[], ceiling: DeclarableLevel
): string[]

export const registerAllTools = <C>(
	server: McpServer, client: C,
	toolCategories: Record<string, ToolDefinition<C>[]>,
	ceilings: ResolvedCeilings['ceilings']
): string[]

export const announceWithheldTools = <C>(
	toolCategories: Record<string, ToolDefinition<C>[]>, resolved: ResolvedCeilings
): void
```

`tool-ceilings.ts`, `error-handling.ts`, `require-changes.ts`, `narrow.ts` lift with zero signature changes; `error-handling.ts`'s one import re-points to the co-located `McpToolResponse`.

### HttpClient (package `src/http/http-client.ts`)

```ts
export class HttpRequestError extends Error {
	constructor(message: string, readonly status?: number,
		readonly retryAfterMs?: number, options?: ErrorOptions)
}

export interface HttpClientOptions {
	/** Absolute URL prefix; endpoint strings are appended verbatim. */
	baseUrl: string
	/**
	 * Returns the Authorization header value. Called first on every attempt, outside
	 * the try — a throw here is a plain Error the classifier never retries, so
	 * credential checks belong in it.
	 */
	authHeader: () => string
	/** Product name for messages: `${label} API Error: 404 - …`. */
	label: string
	/** Appended to the cross-host-redirect message; name the config var to fix, or omit. */
	redirectHint?: string
}
```

The retry policy is deliberately **not** configurable: the status sets, timeouts, ladder, jitter, and spread stay internal constants with their argued-for comments (the sets exist precisely so nobody adds 504 back to the write set; consumer-supplied sets would mean the package can no longer hold that line anywhere). Both known consumers use all the defaults. Every optional field on a published 0.1.0 is API honored forever — a knob is added when a consumer argues for one, with the argument recorded next to it.

```ts
export class HttpClient {
	constructor(options: HttpClientOptions)
	request(method, endpoint, data?, params?, options?: { timeoutMs?: number }): Promise<unknown>
	requestWithRetry(method, endpoint, data?, params?): Promise<unknown>
	/** Verb→policy dispatch; what an app client's methods call. */
	send(method, endpoint, data?, params?): Promise<unknown>
}
```

Module-private and unchanged in behavior: `parseRetryAfter`, `errorFromResponse` (still the single construction site), `causeChain`, `retryAfterFrom`, `describeRedirect` (base text loses the ZENDESK_SUBDOMAIN sentence; `redirectHint` restores it).

### createGoogleHandler (package `src/oauth/google-handler.ts`)

```ts
/** What the consumer's Env must supply — secrets only, no bindings. */
export interface GoogleHandlerSecrets {
	COOKIE_ENCRYPTION_KEY: string
	GOOGLE_CLIENT_ID: string
	GOOGLE_CLIENT_SECRET: string
	HOSTED_DOMAIN?: string
}

/** The Hono app's actual bindings: OAUTH_PROVIDER is injected per request by the
 *  OAuth provider — it must never appear in the consumer-env constraint, because
 *  the wrangler-generated Env doesn't (and shouldn't) declare it. */
export type GoogleHandlerEnv = GoogleHandlerSecrets & { OAUTH_PROVIDER: OAuthHelpers }

export interface GoogleHandlerOptions {
	/** Shown on the approval dialog (renderApprovalDialog's `server`). */
	server: { name: string; description?: string; logo?: string }
}

export const createGoogleHandler = (options: GoogleHandlerOptions): Hono<{ Bindings: GoogleHandlerEnv }>
```

Everything else in the 389 lines — nonce cookie (`SameSite=Lax`), `Headers.append` for the double Set-Cookie, missing-cookie-fatal, `/callback`-never-restarts, all catches — is captured verbatim; only the two product strings become `options.server`.

### createMcpWorker (package `src/index.ts`)

```ts
export interface McpWorkerOptions<TEnv extends GoogleHandlerSecrets, C> {
	/** Passed to `new McpServer(...)`, rebuilt per request — never hoisted, by construction. */
	server: { name: string; version: string; description?: string }
	toolCategories: Record<string, ToolDefinition<C>[]>
	/** Built fresh per request. Must be cheap: config only, no connections. */
	createClient: (env: TEnv) => C
	/** Where the raw ceilings config lives, e.g. `(env) => env.TOOL_CEILINGS`. */
	ceilingsFrom: (env: TEnv) => unknown
	/** Strings for the OAuth approval dialog. */
	approvalDialog: { name: string; description?: string; logo?: string }
	/**
	 * Default 7_776_000 (90 days). How long a refresh token lives is a risk-posture
	 * decision; the default is a moderate middle between the oauth-provider library's
	 * 30 days (a re-auth every month) and a deployment-argued year. State your own
	 * number when your deployment has its own argument — zendesk does.
	 */
	refreshTokenTTL?: number
	/** Default '/mcp'. Used in BOTH places it must be: the apiHandlers key on
	 *  OAuthProvider and createMcpHandler({ route }) — half-applying it 404s. */
	route?: string
	allowedOriginHostnames?: string[]     // passed through to createMcpHandler
	cacheHints?: ServerOptions['cacheHints']
	                                      // default { 'tools/list': { ttlMs: 300_000, cacheScope: 'private' } }
	clientRegistrationTTL?: number        // default 34_560_000
}

/** Returns the OAuthProvider instance to `export default`. Owns the once-per-isolate
 *  announce flag, the per-request server+client build, the per-request ceilings resolve,
 *  the refused-config log on every affected request, and the fetch(request, env, ctx)
 *  wrapper that keeps ctx.props reaching getMcpAuthContext(). Internally types the
 *  handler env as TEnv & { OAUTH_PROVIDER: OAuthHelpers }. */
export const createMcpWorker = <TEnv extends GoogleHandlerSecrets, C>(
	options: McpWorkerOptions<TEnv, C>
): OAuthProvider
```

### Zendesk `src/index.ts` end state (~15 lines)

```ts
export default createMcpWorker<Env, ZendeskClient>({
	server: {
		name: 'Zendesk API Server',
		version: '1.0.0',
		description: 'Remote MCP Server for interacting with the Zendesk API',
	},
	toolCategories,
	createClient: (env) => new ZendeskClient(undefined, env),
	ceilingsFrom: (env) => env.TOOL_CEILINGS,
	approvalDialog: {
		name: 'Momentum Zendesk MCP',
		description: 'Secure access to Zendesk APIs through Model Context Protocol.',
	},
	// One year. The current comment block justifying this figure from the
	// shared-service-account model stays here, next to the value it argues for.
	refreshTokenTTL: 31_536_000,
})
```

### ZendeskClient constructor end state

```ts
constructor(config?: ZendeskClientConfig, env?: ZendeskEnv) {
	const subdomain = sanitizeSubdomain(config?.subdomain || env?.ZENDESK_SUBDOMAIN || '')
	const email = config?.email || env?.ZENDESK_EMAIL || ''
	const apiToken = config?.apiToken || env?.ZENDESK_API_TOKEN || ''
	this.http = new HttpClient({
		baseUrl: `https://${subdomain}.zendesk.com/api/v2`,
		authHeader: () => {
			if (!subdomain || !email || !apiToken)
				throw new Error('Zendesk credentials not configured. Please set environment variables.')
			return `Basic ${btoa(`${email}/token:${apiToken}`)}`
		},
		label: 'Zendesk',
		redirectHint: 'If the Zendesk subdomain has moved, update ZENDESK_SUBDOMAIN.',
	})
}
private send(method, endpoint, data?, params?) { return this.http.send(method, endpoint, data, params) }
// validateId and the 57 API methods unchanged; sanitizeSubdomain becomes a module function
```

## Files to Modify

### Phase A — refactor in place (zendesk repo, one PR, 4–5 commits, suite green after each)

| File                                                                 | Action                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/types/mcp.ts` (new)                                             | `McpToolResponse`, `InferParams`, generic `ToolDefinition<C>` moved out of `types/zendesk.ts` with their doc comments                                                                                                                                                                                                                                                                      |
| `src/types/zendesk.ts`                                               | Delete the three moved declarations and the `ZendeskClient`/`DeclarableLevel` imports; keep payload types, `paginationSchema`, `sortingSchema`                                                                                                                                                                                                                                             |
| `src/utils/tool-registry.ts`                                         | Generic `registerTools<C>`/`registerAllTools<C>`/`announceWithheldTools<C>`; `createTool<S>` becomes `toolFactory<C>()`; imports from `../types/mcp`                                                                                                                                                                                                                                       |
| `src/tools/create-tool.ts` (new)                                     | `export const createTool = toolFactory<ZendeskClient>()` plus `export type ZendeskToolDefinition = ToolDefinition<ZendeskClient>`                                                                                                                                                                                                                                                          |
| `src/tools/*.ts` (13 files)                                          | Two imports each: `createTool` from `'./create-tool'`, and the exported array's `ToolDefinition[]` annotation becomes `ZendeskToolDefinition[]`                                                                                                                                                                                                                                            |
| `src/tools/index.ts`                                                 | Same annotation rebind on `toolCategories`/`allTools` if annotated                                                                                                                                                                                                                                                                                                                         |
| `src/utils/error-handling.ts`                                        | Import `McpToolResponse` from `'../types/mcp'`                                                                                                                                                                                                                                                                                                                                             |
| `src/utils/http-client.ts` (new, ~530 lines)                         | Transport per D3, comments lifted verbatim; messages via `label`/`redirectHint`                                                                                                                                                                                                                                                                                                            |
| `src/utils/http-client.test.ts` (new)                                | Transport tests moved from `zendesk-client.test.ts`; instantiate with Zendesk-shaped options so every assertion string is unchanged                                                                                                                                                                                                                                                        |
| `src/zendesk-client.ts`                                              | Constructor per above; delete transport lines; keep `validateId`, module-level `sanitizeSubdomain`, one-line `send`, 57 API methods; `export { HttpRequestError as ZendeskRequestError }`                                                                                                                                                                                                  |
| `src/zendesk-client.test.ts`                                         | Keep integration-shaped tests (which-methods-retry, credential message, prefixes through real methods); shrink `notAnApiCall` to `{'constructor', 'send', 'validateId'}`                                                                                                                                                                                                                   |
| `src/google-handler.ts`                                              | Wrap the Hono app in `createGoogleHandler(options)`; export `GoogleHandler = createGoogleHandler({ server: { name: 'Momentum Zendesk MCP', … } })` so the test keeps working                                                                                                                                                                                                               |
| `src/create-mcp-worker.ts` (new)                                     | `createMcpWorker` per D5, absorbing index.ts's flag, `createServer`, `mcpHandler` wrapper, OAuthProvider config                                                                                                                                                                                                                                                                            |
| `src/index.ts`                                                       | Shrinks to the config call                                                                                                                                                                                                                                                                                                                                                                 |
| `src/utils/tool-ceilings.test.ts`, `src/utils/tool-registry.test.ts` | Split — and it is per-test, not per-describe: the `announceWithheldTools` describe mixes wrangler-coupled and pure tests. Wrangler-coupled tests move to a new `src/tool-ceilings-config.test.ts` that stays in zendesk forever; the pure registry tests also rebind from `{} as ZendeskClient` casts to a stub client via `toolFactory<StubClient>()`, so the Phase B lift is a pure copy |
| `vitest.thresholds.ts`                                               | Add `http-client.ts` (measured); re-measure `zendesk-client.ts`; add `create-mcp-worker.ts` once its tests exist                                                                                                                                                                                                                                                                           |
| `eslint.config.mjs`                                                  | No change yet (glob `'**/error-handling'` still matches the local path)                                                                                                                                                                                                                                                                                                                    |

### Phase B — the package repo (`levibe/mcp-worker`)

| Package file                                  | Source (post-Phase-A zendesk)              | Changes at lift                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/registry/tool-ceilings.ts` (+test)       | `src/utils/tool-ceilings.ts`               | none                                                                                                                                                                                 |
| `src/registry/tool-registry.ts` (+test)       | `src/utils/tool-registry.ts`               | import paths only                                                                                                                                                                    |
| `src/registry/types.ts`                       | `src/types/mcp.ts`                         | none                                                                                                                                                                                 |
| `src/registry/error-handling.ts` (+test)      | `src/utils/error-handling.ts`              | import path only                                                                                                                                                                     |
| `src/registry/require-changes.ts`             | `src/utils/require-changes.ts`             | none                                                                                                                                                                                 |
| `src/oauth/narrow.ts` (private, not exported) | `src/utils/narrow.ts`                      | copied, not moved — zendesk keeps its own `narrow.ts` (search-response, support-response, and help-center all import `isRecord` and stay); the package's only user is google-handler |
| `src/registry/index.ts` (new)                 | —                                          | barrel                                                                                                                                                                               |
| `src/http/http-client.ts` (+test)             | `src/utils/http-client.ts`                 | none (Zendesk-labeled fixtures are fine as fixtures)                                                                                                                                 |
| `src/http/index.ts` (new)                     | —                                          | barrel                                                                                                                                                                               |
| `src/oauth/google-handler.ts` (+test)         | `src/google-handler.ts`                    | drop the zendesk-bound `GoogleHandler` const; test constructs its own handler                                                                                                        |
| `src/oauth/upstream.ts`                       | `src/utils.ts`                             | none                                                                                                                                                                                 |
| `src/oauth/workers-oauth-utils.ts` (+test)    | `src/workers-oauth-utils.ts`               | delete the five dead `ApprovalDialogOptions` fields; base64 import path                                                                                                              |
| `src/oauth/base64.ts` (+test)                 | `src/utils/base64.ts`                      | none                                                                                                                                                                                 |
| `src/oauth/index.ts` (new)                    | —                                          | barrel                                                                                                                                                                               |
| `src/index.ts` (+test)                        | `src/create-mcp-worker.ts` (+ its A4 test) | plus re-exports of `./registry`; the factory test lifts with it                                                                                                                      |
| Scaffolding                                   | per D2/D7/D8/D10                           | package.json, .npmrc, tsconfig, eslint, vitest config + thresholds, workflows, CHANGELOG, README, CLAUDE.md, LICENSE, .nvmrc                                                         |

Publish 0.1.0: `Bump version to 0.1.0` commit → tag `v0.1.0` → GitHub Release → publish.yml. Smoke-install from a scratch dir with only `GITHUB_PACKAGES_TOKEN` set.

### Phase C — swap zendesk onto the package (one PR)

| File                               | Change                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.npmrc` (new, committed)          | the two `@levibe` registry lines                                                                                                                                                                                                                                                                                                                                                                       |
| `package.json`                     | add `"@levibe/mcp-worker": "^0.1.0"`                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm-workspace.yaml`              | add `'@levibe/mcp-worker@0.1.0'` to `minimumReleaseAgeExclude`, dated comment                                                                                                                                                                                                                                                                                                                          |
| Delete                             | `src/utils/{tool-ceilings,tool-registry,error-handling,base64,require-changes,http-client}.ts` + tests, `src/types/mcp.ts`, `src/google-handler.ts` + test, `src/workers-oauth-utils.ts` + test, `src/utils.ts`, `src/create-mcp-worker.ts` + its test (lifted in B). **`src/utils/narrow.ts` stays** — search-response.ts, support-response.ts, and tools/help-center.ts import `isRecord` and remain |
| `src/index.ts`                     | import `createMcpWorker` from `'@levibe/mcp-worker'`                                                                                                                                                                                                                                                                                                                                                   |
| `src/tools/create-tool.ts`         | `import { toolFactory, type ToolDefinition } from '@levibe/mcp-worker/registry'`; keeps exporting `createTool` and `ZendeskToolDefinition`, so tool files don't change again                                                                                                                                                                                                                           |
| `src/tools/*.ts`                   | `requireChanges` from the package; `paginationSchema`/`sortingSchema` still from `'../types/zendesk'`                                                                                                                                                                                                                                                                                                  |
| `src/zendesk-client.ts`            | `HttpClient`/`HttpRequestError` from `'@levibe/mcp-worker/http'`                                                                                                                                                                                                                                                                                                                                       |
| `src/types/zendesk.ts`             | the `InferParams` import re-points from `'./mcp'` (deleted) to `'@levibe/mcp-worker/registry'` — the 21 payload types depend on it                                                                                                                                                                                                                                                                     |
| `src/tool-ceilings-config.test.ts` | imports from the package; assertions do not change — this is the proof the published surface never moved                                                                                                                                                                                                                                                                                               |
| `eslint.config.mjs`                | `no-restricted-imports` group becomes `['**/error-handling', '@levibe/mcp-worker', '@levibe/mcp-worker/*']`; delete the workers-oauth-utils quarantine override                                                                                                                                                                                                                                        |
| `vitest.thresholds.ts`             | prune departed files; keep zendesk-client + help-center + search/support-response                                                                                                                                                                                                                                                                                                                      |
| `.github/workflows/ci.yml`         | `pnpm install` gains `env: GITHUB_PACKAGES_TOKEN: ${{ secrets.PACKAGES_READ_TOKEN }}` (PAT; same-repo GITHUB_TOKEN cannot read another repo's private package)                                                                                                                                                                                                                                         |
| Cloudflare Workers Builds          | dashboard: add `GITHUB_PACKAGES_TOKEN` as a build env var (build env, not a runtime var)                                                                                                                                                                                                                                                                                                               |
| `CLAUDE.md`                        | replace moved sections with pointers; keep all Zendesk-policy sections                                                                                                                                                                                                                                                                                                                                 |

### Phase D — typeform API check (paper validation only)

| Typeform need                | Package answer                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Fixed base URL, no subdomain | `HttpClient({ baseUrl: 'https://api.typeform.com', … })` ✓                                                                |
| Bearer auth                  | `authHeader: () => { if (!token) throw new Error('Typeform credentials not configured…'); return \`Bearer ${token}\` }` ✓ |
| Error labels                 | `label: 'Typeform'`; `redirectHint` omitted ✓                                                                             |
| Own groups/ceilings          | `resolveCeilings(raw, groups)` already takes groups; var name is the app's via `ceilingsFrom` ✓                           |
| 6 read-only tools            | all `level: 'read'`, all-`read` ceilings; `toolFactory<TypeformClient>()` ✓                                               |
| Worker wiring                | `createMcpWorker({...})` replaces McpAgent/Durable-Object/`/sse` wholesale ✓                                              |
| Retry                        | internal defaults; Retry-After honored ✓                                                                                  |
| `refreshTokenTTL`            | 90-day default fits; typeform states its own only if it argues for one ✓                                                  |

No gap found. The rebuild discards typeform's `workers-mcp`, SDK 1.13, `agents@0.0.100`, dead code, and stale configs wholesale — its own plan.

## Implementation Order (zendesk deployable at every step)

1. **A1** — `types/mcp.ts` + generic registry + `toolFactory` + `tools/create-tool.ts` + test split. `pnpm run validate` green.
2. **A2** — `http-client.ts` extraction, `ZendeskClient` composition, test moves, denylist shrink, thresholds update. Assertion strings byte-identical.
3. **A3** — `createGoogleHandler` factory in place.
4. **A4** — `create-mcp-worker.ts` + shrunken `index.ts` + factory tests. `wrangler deploy --dry-run`; MCP Inspector smoke against `wrangler dev`. Merge + deploy Phase A.
5. **B1** — scaffold `mcp-worker` repo, CI green.
6. **B2** — lift modules + tests; gate with `pnpm pack` + tarball install into zendesk on a scratch branch and run the full zendesk suite (never `pnpm link` for this — a linked package runs its own devDependency zod, the exact two-instance topology the peer strategy exists to prevent; never commit the file specifier).
7. **B3** — README/CLAUDE.md knowledge transfer; open the vendored-file typing issue in the package repo; publish 0.1.0.
8. **C1** — cooldown-metadata check on a scratch branch; then the Phase C PR. Validate green; dry-run; Inspector smoke; merge + deploy.
9. **D** — file the typeform rebuild issue referencing the package; plan separately.

## Verification

- Every Phase A commit: `pnpm run validate` (523 tests; count must not drop except where tests provably moved files) and `wrangler deploy --dry-run`.
- Pinned inventory unchanged: the wrangler.jsonc-parsing describes pass untouched through A and with only import-path changes through C.
- Behavior strings: transport error-message assertions pass verbatim — any edit to those assertions during A is a defect in the extraction, not a test to update.
- Package repo: `pnpm validate`; coverage per D7; `pnpm publish --dry-run` + `pnpm pack`, inspect the tarball (dist JS with `.js` extensions, d.ts, no src).
- Phase C install: fresh clone + `pnpm install --frozen-lockfile` with only `GITHUB_PACKAGES_TOKEN` set; `pnpm why zod` shows a single instance.
- MCP Inspector smoke (after A4 and C1): `tools/list` diffed against a pre-refactor capture (identical); one read round-trips; approval dialog says "Momentum Zendesk MCP"; withheld-tools log appears once, matches pre-refactor.
- After C1 merges: confirm Workers Builds succeeds with the build-env token.
