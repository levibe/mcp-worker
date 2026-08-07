# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@levibe/mcp-worker` packages the MCP-server infrastructure extracted from zendesk-mcp-cloudflare: the tool registry with reach-level ceilings (`src/registry/`), the retrying HTTP transport (`src/http/`), the Google OAuth handler with its nonce-cookie CSRF binding (`src/oauth/`), and the `createMcpWorker` factory (`src/index.ts`) that composes them into a Worker. It publishes to GitHub Packages with subpath exports mirroring those directories.

The modules arrived as a pure copy of the post-Phase-A zendesk tree (zendesk-mcp-cloudflare#93), and the README covers the consumer-facing contracts. What follows is the rationale a change here has to survive.

## The factory owns two invariants that fail silently

MCP revision 2026-07-28 removed protocol-level sessions, and `createMcpWorker` is built the way that implies: it hands `createMcpHandler` a factory that builds a fresh `McpServer` and a fresh client for every request. Nothing is cached across calls and nothing needs to be — a client built by `createClient` holds configuration and opens no connection.

Hoisting the server to module scope to save rebuilding the tools is the mistake the factory exists to make impossible. Nothing in the SDK stops you: `Server.connect` reassigns its transport without complaint, and the single-use check sits on the transport rather than the server, so a shared instance answers sequential requests correctly — which is exactly what local testing produces. It comes apart under concurrency, through teardown rather than dispatch: finishing one exchange closes the server, and closing aborts every request handler still in flight on that instance, so those requests never settle. The failure is invisible until it is load-dependent and hard to attribute. That is why per-request construction sits inside the handler where nobody can hoist it, and why the factory test pins it.

The second invariant is the announcement. `announceWithheldTools` is separate from `registerAllTools` because since the per-request rebuild, anything logged as a side effect of registration would repeat on every tool call. The ceilings come from `env`, which module scope never sees on Workers, so the announcement runs from inside `fetch` behind a once-per-isolate flag — the factory is called once at the consumer's module scope, so its closure lifetime is the isolate's. A refused config is deliberately not folded into that once: failing closed is otherwise invisible, so the refusal is logged on every request it affects while the announcement happens once.

## The tool list's TTL is the only staleness bound

`cacheHints` defaults to five minutes on `tools/list`, `cacheScope: 'private'`. The TTL is not a hint that a client may re-check sooner; it is the only bound on staleness there is, because this architecture cannot tell a client the list changed — `tools/list_changed` needs a long-lived handler holding an event bus, and the handler is rebuilt per request, so every request gets a fresh bus with no subscribers. Hoisting the bus would not fix it either: it would be per-isolate, reaching only the clients that happened to land where something changed. So read the number as an answer to "how long may a client go on offering a tool we have removed", and raise it only with that question in view.

A stale list is a staleness problem rather than a security one. Registration re-runs per request, so a tool a lowered ceiling no longer covers stops existing the moment the new config is live; a client holding the old list gets `Tool not found` when it calls, because publication is enforced at call time and not by what the list says.

`private` rather than `public` because `public` would add only sharing through an intermediary, and the known consumers have none: connectors fetch server-side and `mcp-remote` runs per user. A consumer whose list varies per identity must not raise the scope — per-deployment configuration is what keeps the identical-bytes property true.

## Which tools a consumer's clients can use

Publication is a comparison of two declarations: the level a tool declares at its definition site, and the ceiling its group's deployment config carries. `registerTools` offers a tool exactly when its level fits under the ceiling, and returns what it withheld. The vocabulary in `src/registry/tool-ceilings.ts` is ordered `read < stage < write < delete`, drawn on whether the thing takes effect without a human having looked at it — `stage` builds something inert, `write` touches something live.

`activate` — making a staged thing take effect — is in the vocabulary and deliberately undeclarable: no tool can carry it and no ceiling can permit it, so "this server never activates anything" is a type rather than a habit. The full vocabulary and the declarable subset are separate types on purpose. The ban is a policy expressed through the mechanism, not a limitation of it; a consumer that genuinely activates things argues for its own subset rather than forking the vocabulary.

The level is a required argument of the bound tool factory with no default, because a default is either fail-open or a silent withhold — the safety property is "nothing is exposed until a human classified it". The tool's name plays no part, so no naming convention ever publishes a future tool by itself. A withheld tool stays live code — compiled, linted, tested — because withholding is a runtime comparison against configuration, which no static analysis can prove dead. `resolveCeilings` fails closed to `read` on every group when the config is missing or malformed, and the caller logs the refusal loudly because a silent fail-closed just looks like tools vanishing.

## A cookie is what binds the OAuth state, and a signature would not

`redirectToGoogle` mints a random nonce, puts it in the `state` Google hands back and sets it as an `HttpOnly; Secure; SameSite=Lax` cookie, and `/callback` refuses anything where the two disagree. That is what stops an authorization-code injection: an attacker starts a flow of their own and hands the victim the resulting callback URL, and without this the victim's client session ends up bound to the attacker's Google identity.

The trap is thinking an HMAC would do instead — `signData` is right there in `src/oauth/workers-oauth-utils.ts`, so the shortcut is available. Signing proves the state is one we minted, and the attacker's state **is** one we minted, obtained by starting a flow themselves. What an attacker cannot do is set a cookie on somebody else's browser, so the cookie is the control.

Three details each fail in a way that looks like something else:

- `SameSite=Lax` is required rather than chosen. The return from Google is a cross-site top-level navigation, which `Lax` permits and `Strict` drops — so `Strict` would refuse every sign-in rather than only the forged ones.
- The `Set-Cookie` has to go on a `Headers` and be `append`ed. `POST /authorize` already carries the approval cookie, and a second `Set-Cookie` key on a plain object literal replaces it rather than accompanying it, so the approval is silently discarded and nothing about the redirect looks wrong.
- A missing cookie is fatal, and that is the deliberate cost. The alternative is a check that is decorative, since the attack's ordinary shape is a browser presenting no cookie at all.

`/callback` cannot restart the flow to soften that: restarting means calling `redirectToGoogle` directly, and `GET /authorize` only reaches that after the approval gate — so a restart skips consent and inverts the attack rather than fixing it.

## The transport

The in-code comments in `src/http/http-client.ts` are the spec for the retry model; change behavior only by arguing with them where they sit. The short form: the verb picks the policy, a single deadline covers every attempt and every backoff, `Retry-After` is honored and never clamped, the statusless case retries for reads and never for writes, and `errorFromResponse` is the single construction site for failures raised once a response is in hand. `HttpRequestError` carries the HTTP status when the API answered and leaves it undefined when the request never completed; classify on that and on nothing else.

The policy is deliberately not configurable through `HttpClientOptions`. The status sets exist precisely so nobody adds 504 back to the write set, and consumer-supplied sets would mean this package could no longer hold that line anywhere. Every optional field on a published release is API honored forever; a knob gets added when a consumer argues for one, with the argument recorded next to it.

App identity enters through options instead: `label` prefixes the error messages, `redirectHint` optionally extends the cross-host-redirect message, and the credential gate lives in the consumer's `authHeader` closure — it is called first on every attempt, outside the try, so a throw there is a plain `Error` the classifier never retries.

## Dependency policy

Everything whose types or instances cross the boundary is a peer, never a dependency; zod and `@modelcontextprotocol/server` required, `agents`, `hono` and the oauth-provider optional. All five are duplicated in devDependencies so this repo's own tests run. The two-zod hazard and the resulting never-`pnpm link` verification rule are documented in the README — the B-gate shape is `pnpm pack` plus a tarball install into the consumer.

`@cloudflare/workers-types` is a devDependency only, wired through `tsconfig.json` as `@cloudflare/workers-types/latest` (the bare entrypoint is the oldest compatibility date and predates `Headers.getSetCookie`). The emitted d.ts refers to `Request`, `Response`, `Headers` and `ExecutionContext` as bare globals, which resolve against the consumer's own generated types — the package forces nothing ambient on consumers. The root `env.d.ts` plays the consumer's generated-`Env` role for the lifted OAuth tests and sits outside `src/` so the build never sees it.

The supply-chain settings in `pnpm-workspace.yaml` follow the house convention: 7-day `minimumReleaseAge`, strict, with exact-version exclusion pins that expire by themselves. The pins were copied from zendesk-mcp-cloudflare with their comments; the trap worth remembering is that `agents@latest` quietly resolves to 0.18.0, which predates `createMcpHandler`.

## Code quality

Prettier owns formatting and ESLint owns everything else, switched apart through `eslint-config-prettier`. `no-explicit-any` is held at `error` across the whole package, vendored code included; a new `any` anywhere needs its own argued-for exemption.

The `no-restricted-imports` guard on `withErrorHandling` exists because `registerTools` is the only place that may call it — a second wrap encodes the inner response as the text of the outer one and buries `isError`, so a failed write reports as a success. The exemptions are the defining file, the one call site, the registry barrel (a re-export is an import to this rule), and tests. The README carries the copy-paste version of the same guard for consumers.

## Testing

Vitest with no runtime of its own: everything under test is pure or reachable through a stubbed `fetch`. Spy and stub teardown lives in `vitest.config.ts` (`restoreMocks`, `unstubGlobals`) rather than per-file `afterEach`; fake timers still need `vi.useRealTimers()` per file. Coverage measures all of `src/` so untested modules sit visibly at 0%, nothing gates on the overall number, and the per-file ratchets live in `vitest.thresholds.ts` with the reasoning for which metrics each pins — they have to stay in that separate file because the CI reporting action regexes `vitest.config.ts` and would misread any inline number as a project-wide target. Set thresholds from the measured value rounded down; say so in the commit when you lower one.

Error-message assertion strings are behavior, not tests to update. They were kept byte-identical through the extraction, and the zendesk suite passing against this package's tarball is what proved the lift; an edit to one of those assertions is a semver-visible change to what consumers match on.

```bash
pnpm install             # needs GITHUB_PACKAGES_TOKEN set for the committed .npmrc
pnpm run validate        # type-check, lint, format:check, test, build — what CI runs, split
pnpm run test:watch      # re-run on change while working
pnpm run test:coverage   # coverage report (text plus coverage/index.html)
```

## Releasing

Keep a Changelog. The release is a `Bump version to X.Y.Z` commit, a `vX.Y.Z` tag, and a GitHub Release; publish.yml fires on the release, re-validates, checks the version against the tag, and publishes to GitHub Packages. `prepublishOnly` runs `validate`, so a red suite cannot publish. Consumers adopting a release inside the 7-day window pin the exact version in their `minimumReleaseAgeExclude` with a dated comment.
