# @levibe/mcp-worker

Shared MCP server infrastructure for Cloudflare Workers: a tool registry with reach-level ceilings, a retrying fetch transport, and Google OAuth for MCP clients, composed by one factory that returns the Worker to `export default`.

The modules were extracted from [zendesk-mcp-cloudflare](https://github.com/levibe/zendesk-mcp-cloudflare) after they had been running in production there. That repo's CLAUDE.md and this one carry the design arguments; this README covers what a consumer needs to get right.

## Surfaces

Subpath exports keep dependency reach honest. A consumer of `./registry` plus `./http` needs none of the optional peers.

| Import path                   | What it carries                                                                                                                                                                                                               | Runtime peers it needs                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `@levibe/mcp-worker`          | `createMcpWorker`, plus everything `./registry` exports                                                                                                                                                                       | all five                                             |
| `@levibe/mcp-worker/registry` | `toolFactory`, `ToolDefinition`, `registerTools`, `registerAllTools`, `announceWithheldTools`, `resolveCeilings`, `isWithinCeiling`, the level types, `withErrorHandling`, `requireChanges`, `McpToolResponse`, `InferParams` | zod (types only from `@modelcontextprotocol/server`) |
| `@levibe/mcp-worker/http`     | `HttpClient`, `HttpRequestError`, `HttpClientOptions`                                                                                                                                                                         | none                                                 |
| `@levibe/mcp-worker/oauth`    | `createGoogleHandler`, `GoogleHandlerSecrets`, `GoogleHandlerEnv`, `Props`, the upstream OAuth helpers, the approval dialog, the base64 helpers                                                                               | hono, `@cloudflare/workers-oauth-provider`           |

## Installing

The package lives on GitHub Packages, which requires a token to install even public packages. The registry mapping is safe to commit; the credential is not, and since pnpm 11 it cannot be. pnpm refuses to expand environment variables in auth settings that come from a committed project-level `.npmrc`, because that file could route the secret to an attacker-controlled registry. It warns and then sends no Authorization header at all, so the install fails with a 401 that looks like a bad token rather than an ignored one.

Commit an `.npmrc` with only the mapping:

```
@levibe:registry=https://npm.pkg.github.com
```

Then add the dependency:

```bash
pnpm add @levibe/mcp-worker
```

The credential is a classic PAT with `read:packages`. The package is public, so the PAT needs that scope and nothing else (note that `gh auth token` does not carry it). What varies per environment is how the credential reaches pnpm from a source it still trusts, which means user-level config:

- **Locally**: put the credential in your user-level `~/.npmrc`, where pnpm still expands environment references:

  ```
  //npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
  ```

- **GitHub Actions**: let `actions/setup-node` write the credential into a runner-owned user-level config, and pass the token to every step that runs pnpm (an env reference in config errors when the variable is unset, so job-level `env` is simplest):

  ```yaml
  - uses: actions/setup-node@v4
    with:
      registry-url: https://npm.pkg.github.com
      scope: '@levibe'
  - run: pnpm install --frozen-lockfile
    env:
      NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_READ_TOKEN }}
  ```

- **Cloudflare Workers Builds**: three dashboard settings, all of them build-time values rather than runtime vars. Set `SKIP_DEPENDENCY_INSTALL=true` as a build variable, because Workers Builds otherwise runs its automatic dependency install before the build command executes, and that install 401s on this package before any credential could be configured (both deployed consumers hit exactly this on their first connected build). Set `GITHUB_PACKAGES_TOKEN` as a build secret rather than a plain build variable, so Workers Builds keeps the token masked in the build logs. Then have the build command authenticate and install itself, ahead of its deploy step:

  ```sh
  pnpm config set //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN" && pnpm install --frozen-lockfile
  ```

  `pnpm config set` writes the token into user-level config as a literal, so nothing depends on env-var expansion, and it is the same authenticate command the consumers' CI workflows run before their installs, so the two deploy paths cannot drift. The alternative, which avoids the skip variable: commit the credential reference as a separate file (say `.npmrc.build`) and set `NPM_CONFIG_USERCONFIG` pointing at that file alongside `GITHUB_PACKAGES_TOKEN`. Designating the file as user-level config is what makes pnpm willing to expand it, and the automatic install then authenticates by itself.

## Quick start

```ts
// src/tools/create-tool.ts: bind the registry to your client once.
import { toolFactory, type ToolDefinition } from '@levibe/mcp-worker/registry'
import type { MyClient } from '../my-client'

export const createTool = toolFactory<MyClient>()
export type MyToolDefinition = ToolDefinition<MyClient>
```

```ts
// src/index.ts: one config call builds the whole Worker.
import { createMcpWorker } from '@levibe/mcp-worker'
import { MyClient } from './my-client'
import { toolCategories } from './tools'

export default createMcpWorker<Env, MyClient>({
	server: { name: 'My API Server', version: '1.0.0' },
	toolCategories,
	createClient: (env) => new MyClient(env),
	ceilingsFrom: (env) => env.TOOL_CEILINGS,
	approvalDialog: { name: 'My MCP' },
})
```

The factory owns two invariants that fail silently under local testing and loudly under load: the `McpServer` and the client are rebuilt for every request, and the withheld-tools announcement runs once per isolate from inside `fetch`. Do not reconstruct this wiring by hand to save a dependency; the doc comment on `createMcpWorker` explains what goes wrong.

Defaults a deployment can override, each documented on `McpWorkerOptions`: `route` (`/mcp`, or an array to mount the endpoint on several paths at once — `['/mcp', '/']` also answers at a bare subdomain root, though the bare root works only for clients you drive yourself and not for Claude's hosted connector, which needs the `/mcp` URL; the doc comment on `route` explains why), `refreshTokenTTL` (90 days; a risk-posture decision, so state your own number when your deployment has its own argument), `clientRegistrationTTL` (400 days), `cacheHints` (five minutes on `tools/list`), `allowedOriginHostnames` (widen browser origins one hostname at a time, never with a wildcard), and `requireAllowedEmails` (off; when true, a blank or unset `ALLOWED_EMAILS` refuses every sign-in instead of admitting anyone — state it on a deployment whose tools are not for strangers).

## The companion env.d.ts

`wrangler types` generates an `Env` with bindings and plain vars only. Secrets set through the dashboard or `wrangler secret put` never appear in it, so on day one `createMcpWorker<Env, C>` fails its `TEnv extends GoogleHandlerSecrets` constraint with an error that reads like a broken package rather than a missing field. Hand-maintain a companion `env.d.ts` that merges the secret contract into the generated interface:

```ts
// env.d.ts, committed. Keep in sync with the secrets you actually set.
interface Env {
	GOOGLE_CLIENT_ID: string
	GOOGLE_CLIENT_SECRET: string
	COOKIE_ENCRYPTION_KEY: string
	// Optional: restricts Google sign-in to a single hosted domain.
	HOSTED_DOMAIN?: string
	// Optional: restricts Google sign-in to a comma-separated list of exact addresses.
	ALLOWED_EMAILS?: string
}
```

## The OAUTH_KV assumption

The OAuth provider library looks up its KV namespace by the literal binding name `OAUTH_KV`. Nothing in the types enforces this, so a differently named binding fails at request time, not at deploy time. Bind it exactly:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "..." }]
```

## The double-wrap trap

`registerTools` applies `withErrorHandling` to every handler already. A handler that wraps its own result gets encoded a second time: the inner response becomes the text of the outer one, `isError` is buried where no client can see it, and a write the upstream API rejected reads back as a success. Nothing about it looks wrong until a write fails, which is how it once eroded onto every write handler in the zendesk tree at once.

Handlers return the client's result and pass a worded confirmation as the final argument to `createTool`. Hold the line with lint; this package carries the same guard internally:

```js
// eslint.config.mjs
{
	files: ['src/**/*.ts'],
	ignores: ['src/**/*.test.ts'],
	rules: {
		'no-restricted-imports': [
			'error',
			{
				patterns: [
					{
						group: ['@levibe/mcp-worker', '@levibe/mcp-worker/*'],
						importNames: ['withErrorHandling'],
						message:
							'registerTools wraps every handler in withErrorHandling already. Wrapping again encodes the response as text and drops its isError, reporting a failed write as a success. Return the client result and pass a successMessage to your createTool instead.',
					},
				],
			},
		],
	},
}
```

## Peer dependencies and the two-zod hazard

Everything whose types or instances cross the package boundary is a peer, never a dependency: zod, `@modelcontextprotocol/server`, and optionally `agents`, `hono`, and `@cloudflare/workers-oauth-provider`. zod is the load-bearing one. `ZodRawShape` crosses in `ToolDefinition.schema`, and two zod instances break `instanceof` and inference in ways that surface far from the cause. After installing, `pnpm why zod` should find exactly one version.

The same hazard is why `pnpm link` must not be used to verify this package against a consumer: a linked package resolves imports through its own `node_modules`, which holds its devDependency copy of zod, so a linked run executes the exact two-instance topology the peer strategy exists to prevent. Verify with `pnpm pack` and a tarball install instead. Linking stays useful only for type-checking during the inner loop.

## Invariants the code holds

Worth knowing before changing anything, because each one looks refactorable into something worse:

- **`errorFromResponse` is the single construction site** for transport errors raised once a response is in hand. The status and `Retry-After` are read off the `Response` itself rather than passed by a call site that has to remember to. Raising an `HttpRequestError` by hand inside that `try` makes a refusal the API stated plainly read as a request that never got an answer, and it gets sent again.
- **`activate` has no rank.** The level vocabulary is `read < stage < write < delete`, plus `activate`, which no tool can declare and no ceiling can permit. "This server never activates anything" is a type, not a habit. A consumer that does activate things argues for its own declarable subset rather than forking the vocabulary.
- **The retry policy is not configurable.** The status sets, timeouts, ladder, jitter, and spread are internal constants with their arguments attached in `http-client.ts`. The sets exist precisely so nobody adds 504 back to the write set; consumer-supplied sets would mean the package could no longer hold that line anywhere.
- **The protected-resource metadata names only routes that exist.** The OAuth provider answers an RFC 9728 document at every path under `/.well-known/oauth-protected-resource` and derives the `resource` it advertises from the path it was asked at, so the path-less URL advertises the bare origin whether or not anything is mounted there — and a client that discovers through it holds a grant whose RFC 8707 resource is a URL the worker 404s. The factory serves those documents for its mounted routes and refuses the rest, so `route` is what decides which ones exist: mount `/` and the path-less document starts being served, because there it is true. Answering it with the canonical endpoint instead is not open to us, because RFC 9728 §3.3 requires the returned `resource` to be identical to the identifier the metadata URL was built from and tells a client to discard a response where it is not.

## Development

```bash
pnpm install             # no token needed: nothing here installs from GitHub Packages
pnpm run validate        # type-check, lint, format:check, test, build
pnpm run test:watch      # re-run on change
pnpm run test:coverage   # coverage report (text plus coverage/index.html)
```

Releasing: commit `Bump version to X.Y.Z` with a CHANGELOG entry, tag `vX.Y.Z`, create the GitHub Release. The publish workflow validates, checks the version against the tag, and publishes to GitHub Packages. Consumers that adopt a release within 7 days of publish need an exact `minimumReleaseAgeExclude` pin with a dated comment, per the house self-expiring convention.
