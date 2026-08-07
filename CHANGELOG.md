# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The vendored `workers-oauth-utils` is typed by narrowing from `unknown`; the scoped `no-explicit-any` override is gone and the rule holds at `error` package-wide
- `ApprovalDialogOptions.state` is `object` and `ParsedApprovalResult.state` is `Record<string, unknown> & { oauthReqInfo?: unknown }`, both formerly `any`-typed. Passing state in accepts what it always did; reading the returned state now yields `unknown` values that need narrowing where `any` compiled unchecked
- `parseRedirectApproval` refuses a state whose `oauthReqInfo.clientId` is a truthy non-string; it previously wrote it into the approval cookie, which the cookie's own reader then rejected wholesale
- The repository and package are public; installing still needs a token with `read:packages`, but no repository access

### Fixed

- The README install flow no longer 401s under pnpm 11: the committed `.npmrc` keeps only the registry mapping, and the credential moves to user-level config per environment

## [0.1.0] - 2026-08-05

### Added

- `createMcpWorker` factory on the root entry: per-request `McpServer` and client construction, once-per-isolate withheld-tools announcement, documented TTL and route defaults
- `./registry`: `toolFactory`, tool ceilings (`read < stage < write < delete`, `activate` undeclarable), `registerTools`/`registerAllTools`, `withErrorHandling`, `requireChanges`
- `./http`: `HttpClient` with the verb-driven retry policy, single-deadline bounding, and `Retry-After` handling; `HttpRequestError`
- `./oauth`: `createGoogleHandler` with the nonce-cookie CSRF binding, the vendored approval dialog, upstream OAuth helpers, UTF-8-safe base64 helpers
- All lifted as a pure copy from zendesk-mcp-cloudflare after its Phase A parameterization (zendesk-mcp-cloudflare#93); the five dead `ApprovalDialogOptions` cookie fields were dropped at lift time
