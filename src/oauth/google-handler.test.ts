/**
 * `/callback` is a public, unauthenticated endpoint, and every value it reads arrives through
 * the user's browser. Most of what is asserted here is therefore about what it refuses: a
 * malformed `state` has to come back as a 400 that says one fixed thing, never as the bare 500
 * an unhandled `atob` or `JSON.parse` throw used to produce.
 *
 * The whole handler is driven through `GoogleHandler.request(...)` with a stubbed env, which is
 * the same shape a real request takes. Nothing here needs workerd: Google is reached through
 * the global `fetch` these tests stub, and the OAuth provider is an object on that env.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { createGoogleHandler } from './google-handler'
import { decodeBase64Json, encodeBase64Json } from './base64'
import {
	clientIdAlreadyApproved,
	parseRedirectApproval,
	renderApprovalDialog,
} from './workers-oauth-utils'

// Those three helpers are the seam between /authorize and the signed approval cookie, and they
// have tests of their own next door. Replacing the module is what lets these tests state the
// decision the route turns on — this client is already approved, this approval is well-formed —
// instead of minting a signed cookie to say it, and what makes the dialog something a test can
// recognise without parsing a page of HTML.
vi.mock('./workers-oauth-utils', () => ({
	clientIdAlreadyApproved: vi.fn(),
	parseRedirectApproval: vi.fn(),
	renderApprovalDialog: vi.fn(),
}))

/** The generic flow bound to a fixture identity, the way a consumer's deployment binds it. */
const GoogleHandler = createGoogleHandler({
	server: {
		name: 'Momentum Zendesk MCP',
		description: 'Secure access to Zendesk APIs through Model Context Protocol.',
	},
})

const authRequest: AuthRequest = {
	responseType: 'code',
	clientId: 'test-client',
	redirectUri: 'https://client.example.com/oauth/callback',
	scope: ['profile', 'email'],
	state: 'client-state',
}

/**
 * The nonce binding a state to the browser that started the flow, and the cookie carrying it.
 *
 * A fixed value rather than a real UUID, because what the tests exercise is whether the two
 * halves are compared, not how the nonce was generated. The one test that cares about the
 * generation asserts the two agree rather than pinning a value.
 */
const NONCE = 'test-nonce-3f2a'
const NONCE_COOKIE = `mcp-auth-nonce=${NONCE}`

/** The state exactly as redirectToGoogle mints it, nonce included. */
const validState = btoa(JSON.stringify({ ...authRequest, nonce: NONCE }))

/** What lookupClient hands the approval dialog to name the client asking. */
const clientInfo = {
	clientId: 'test-client',
	clientName: 'Test MCP Client',
	redirectUris: ['https://client.example.com/oauth/callback'],
}

/** The hostname the worker is deployed on, unless a test says otherwise. */
const workerOrigin = 'https://zendesk-mcp.example.workers.dev'

let completeAuthorization: Mock
let googleFetch: Mock
let lookupClient: Mock
let parseAuthRequest: Mock
let tokenResponse: () => Response
let userinfoResponse: () => Response

const testEnv = (overrides: Record<string, unknown> = {}) =>
	({
		GOOGLE_CLIENT_ID: 'test-google-client-id',
		GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
		COOKIE_ENCRYPTION_KEY: 'test-cookie-secret',
		ZENDESK_SUBDOMAIN: 'example',
		ZENDESK_EMAIL: 'service-account@example.com',
		ZENDESK_API_TOKEN: 'test-zendesk-token',
		OAUTH_PROVIDER: { completeAuthorization },
		...overrides,
	}) as unknown as Env & { OAUTH_PROVIDER: OAuthHelpers }

/**
 * The cookie defaults to one matching `validState`, so a test that is not about the nonce does
 * not have to say anything about it. Pass `null` to send no cookie at all, or another string to
 * send one that does not match.
 */
const callback = (
	query: Record<string, string>,
	env = testEnv(),
	cookie: string | null = NONCE_COOKIE,
) =>
	GoogleHandler.request(
		`/callback?${new URLSearchParams(query).toString()}`,
		cookie === null ? undefined : { headers: { cookie } },
		env,
	)

/** /authorize reaches for two provider methods that /callback never touches. */
const authorizeEnv = (overrides: Record<string, unknown> = {}) =>
	testEnv({
		OAUTH_PROVIDER: { completeAuthorization, lookupClient, parseAuthRequest },
		...overrides,
	})

const authorize = (env = authorizeEnv(), origin = workerOrigin) =>
	GoogleHandler.request(`${origin}/authorize`, undefined, env)

const approve = (env = authorizeEnv(), origin = workerOrigin) =>
	GoogleHandler.request(`${origin}/authorize`, { method: 'POST' }, env)

/** The Google consent URL a 302 points at, ready to be read parameter by parameter. */
const googleUrl = (response: Response) => new URL(response.headers.get('location') ?? '')

beforeEach(() => {
	completeAuthorization = vi.fn(async () => ({
		redirectTo: 'https://client.example.com/oauth/callback?code=granted',
	}))

	// Both Google calls answer successfully by default, so a test only has to say what it wants
	// to go wrong. Anything else asking for the network is a bug in the test rather than a
	// request worth answering, hence the throw.
	tokenResponse = () => Response.json({ access_token: 'google-access-token' })
	userinfoResponse = () =>
		Response.json({
			verified_email: true,
			id: 'google-user-1',
			name: 'Ada Lovelace',
			email: 'ada@example.com',
		})

	googleFetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input)
		if (url.startsWith('https://accounts.google.com/o/oauth2/token')) return tokenResponse()
		if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return userinfoResponse()
		throw new Error(`Unexpected fetch to ${url}`)
	})
	vi.stubGlobal('fetch', googleFetch)
})

describe('GET /callback', () => {
	describe('a state it cannot trust', () => {
		beforeEach(() => {
			// The base64 and JSON cases log their real reason. Silenced so a passing run stays
			// readable; the test below asserts on what that log actually carries.
			vi.spyOn(console, 'warn').mockImplementation(() => {})
		})

		// Every entry below reached `atob` or `JSON.parse` unguarded before, so each was a 500
		// anyone could produce by hand. Asserting the body as well as the status is what proves
		// the handler answered rather than Hono's onError catching a throw on its way out —
		// an escaping exception reads as 500 'Internal Server Error', not 400 'Invalid state'.
		it.each([
			['the parameter is absent', undefined],
			['the parameter is empty', ''],
			['it is not valid base64', 'not-valid-base64!!'],
			['it is base64 but not JSON', btoa('not json at all')],
			['it decodes to JSON null', btoa('null')],
			['it decodes to a bare number', btoa('7')],
			['it decodes to a bare string', btoa('"a string"')],
			// `isRecord` tests only that the value is a non-null object, so an array satisfies it
			// and the clientId check is what turns this one away. Worth a row of its own: tighten
			// `isRecord` or reorder the checks and this is the case that moves.
			['it decodes to an array', btoa('[]')],
			['it parses but carries no clientId', btoa(JSON.stringify({ scope: ['profile'] }))],
			['its clientId is not a string', btoa(JSON.stringify({ ...authRequest, clientId: 7 }))],
			['its clientId is empty', btoa(JSON.stringify({ ...authRequest, clientId: '' }))],
		])('answers 400 when %s', async (_label, state) => {
			const response = await callback(state === undefined ? { code: 'g' } : { state, code: 'g' })

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid state')
		})

		it('never reaches Google with a state it rejected', async () => {
			await callback({ state: 'not-valid-base64!!', code: 'google-code' })

			expect(googleFetch).not.toHaveBeenCalled()
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// Same split as the catch around parseAuthRequest on /authorize: the caller is
		// unauthenticated, so the reason goes to the log and the response stays a fixed string.
		// Relaying the decoder's own text would tell a prober which of the three steps it broke.
		it('logs the real decode failure without relaying it to the caller', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

			const response = await callback({ state: btoa('not json at all'), code: 'google-code' })

			expect(warn).toHaveBeenCalledWith(
				'Callback state could not be decoded:',
				expect.stringMatching(/./),
			)
			await expect(response.text()).resolves.toBe('Invalid state')
		})
	})

	// Both halves of the pair moved together in #74, so what /callback reads is what
	// redirectToGoogle now mints — UTF-8 base64 — plus whatever the old encoder minted before
	// the deploy and left in flight or sitting in a browser. The decoder is shared with the
	// approval cookie, whose one-year Max-Age is why the legacy path is permanent rather than
	// a migration window; these drive both formats through the callback's own decode.
	describe('a state carrying more than ASCII', () => {
		it('completes a flow whose state carries text bare btoa refused', async () => {
			const state = encodeBase64Json({ ...authRequest, state: 'Āé😀', nonce: NONCE })

			const response = await callback({ state, code: 'google-code' })

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledWith(
				expect.objectContaining({ request: expect.objectContaining({ state: 'Āé😀' }) }),
			)
		})

		// Latin-1 is the only non-ASCII the old encoder could write — it threw on everything
		// above U+00FF — and its single bytes are invalid UTF-8, so this is the case that
		// exercises the fallback rather than agreeing with the new format byte for byte.
		it('still reads a state the old bare-btoa encoder minted', async () => {
			const legacy = btoa(JSON.stringify({ ...authRequest, state: 'café', nonce: NONCE }))

			const response = await callback({ state: legacy, code: 'google-code' })

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledWith(
				expect.objectContaining({ request: expect.objectContaining({ state: 'café' }) }),
			)
		})
	})

	it('answers 400 when the code is missing', async () => {
		const response = await callback({ state: validState })

		expect(response.status).toBe(400)
		await expect(response.text()).resolves.toBe('Missing code')
		expect(googleFetch).not.toHaveBeenCalled()
	})

	describe('the Google exchange', () => {
		// These stay 500 while the guards above and below them answer a fixed 400, and the split is
		// deliberate rather than a path this pass did not reach. A 400 says the caller sent
		// something bad. Here the caller sent nothing wrong at all — Google refused us — so the
		// status reports the dependency instead of blaming the request.
		it('answers 500 when the token exchange fails', async () => {
			vi.spyOn(console, 'log').mockImplementation(() => {})
			tokenResponse = () => new Response('invalid_grant', { status: 400 })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(500)
			await expect(response.text()).resolves.toBe('Failed to fetch access token')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('answers 400 when Google returns no access token', async () => {
			tokenResponse = () => Response.json({ token_type: 'Bearer' })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(400)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('answers 500 when the user info request fails', async () => {
			userinfoResponse = () => new Response('token expired', { status: 401 })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(500)
			await expect(response.text()).resolves.toContain('Failed to fetch user info')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})
	})

	// completeAuthorization is the last place a forged state can still reach, and it is the only
	// thing that validates the rest of it — the clientId check up front is the whole of what
	// happens before here. It validates by throwing: an unregistered client, a missing
	// redirectUri, and a redirect URI the client never registered each raise. Those checks are
	// the ones that matter and they hold, so there is no open redirect. What was wrong is that
	// nothing caught them, so the answer was a bare 500 that anyone could produce at will once
	// they had signed in with Google — which is the property this guard exists to remove.
	describe('a state the provider rejects', () => {
		beforeEach(() => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
		})

		it.each([
			['the client is not registered', new Error('Client not found')],
			['the redirect URI is not one the client registered', new Error('Invalid redirect URI')],
			// Not a shape the provider actually rejects — `scope` is only joined on the
			// implicit-grant branch, and every client here is responseType: 'code'. Kept as a
			// bare TypeError because the catch has to hold for anything the provider throws, not
			// only for the refusals it words itself.
			['it throws a TypeError from somewhere inside', new TypeError('Cannot read properties')],
		])('answers 400 rather than 500 when %s', async (_label, thrown) => {
			completeAuthorization.mockRejectedValue(thrown)

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid authorization request')
		})

		// Same split as the two catches above it: the caller is unauthenticated, so the provider's
		// own wording goes to the log and the response stays a fixed string.
		it('logs the provider reason without relaying it to the caller', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			completeAuthorization.mockRejectedValue(new Error('Client not found: no-such-client'))

			const response = await callback({ state: validState, code: 'google-code' })

			expect(error).toHaveBeenCalledWith(
				'completeAuthorization rejected the request:',
				'Client not found: no-such-client',
			)
			await expect(response.text()).resolves.not.toContain('no-such-client')
		})

		// The String(error) arm of the ternary. Reachable here, unlike the decode catch above,
		// because what throws is a stub rather than atob or JSON.parse.
		it('logs a thrown non-Error as a string', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			completeAuthorization.mockRejectedValue('a bare string')

			const response = await callback({ state: validState, code: 'google-code' })

			expect(error).toHaveBeenCalledWith(
				'completeAuthorization rejected the request:',
				'a bare string',
			)
			expect(response.status).toBe(400)
		})
	})

	describe('HOSTED_DOMAIN', () => {
		it('refuses a sign-in from outside the hosted domain', async () => {
			userinfoResponse = () =>
				Response.json({
					verified_email: true,
					id: 'google-user-2',
					name: 'Outsider',
					email: 'ada@elsewhere.com',
				})

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: 'example.com' }),
			)

			expect(response.status).toBe(403)
			await expect(response.text()).resolves.toBe(
				'Access restricted to example.com domain users only',
			)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// The check is `endsWith('@' + HOSTED_DOMAIN)` rather than a suffix match on the domain
		// alone, which is what keeps a lookalike domain out. Worth pinning, because dropping the
		// '@' would look like a harmless simplification and would admit both of these.
		it.each(['ada@notexample.com', 'ada@sub.example.com'])(
			'refuses %s against a hosted domain of example.com',
			async (email) => {
				userinfoResponse = () =>
					Response.json({ verified_email: true, id: 'google-user-3', name: 'Lookalike', email })

				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ HOSTED_DOMAIN: 'example.com' }),
				)

				expect(response.status).toBe(403)
			},
		)

		it('admits a sign-in from inside the hosted domain', async () => {
			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: 'example.com' }),
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// A domain is case-insensitive, so neither of these should turn a permitted user away.
		// Google hands back a lowercase address in practice, which is why nobody was hitting
		// this — an access control should not rest on a habit of the identity provider's.
		it.each([
			['an address Google sent in mixed case', 'Ada@EXAMPLE.COM', 'example.com'],
			['a HOSTED_DOMAIN written in mixed case', 'ada@example.com', 'Example.COM'],
			['both sides in mixed case', 'ADA@Example.com', 'EXAMPLE.com'],
		])('admits %s', async (_label, email, hostedDomain) => {
			userinfoResponse = () =>
				Response.json({ verified_email: true, id: 'google-user-5', name: 'Ada', email })

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: hostedDomain }),
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// Lowercasing must not weaken the lookalike check the block above pins.
		it('still refuses a lookalike domain when the case differs', async () => {
			userinfoResponse = () =>
				Response.json({
					verified_email: true,
					id: 'google-user-6',
					name: 'Lookalike',
					email: 'Ada@NOTEXAMPLE.COM',
				})

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: 'Example.com' }),
			)

			expect(response.status).toBe(403)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('admits any domain when HOSTED_DOMAIN is unset', async () => {
			userinfoResponse = () =>
				Response.json({
					verified_email: true,
					id: 'google-user-4',
					name: 'Anyone',
					email: 'anyone@elsewhere.com',
				})

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})
	})

	describe('ALLOWED_EMAILS', () => {
		// The body is pinned exactly, and what it must not carry matters as much as what it
		// does: the domain refusal above names the domain, which is an organization's public
		// name, but this list is private addresses and none of them may ride back to an
		// unauthenticated caller.
		it('refuses a sign-in from an address not on the list', async () => {
			userinfoResponse = () =>
				Response.json({
					verified_email: true,
					id: 'google-user-7',
					name: 'Outsider',
					email: 'mallory@example.com',
				})

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ ALLOWED_EMAILS: 'ada@example.com,grace@elsewhere.com' }),
			)

			expect(response.status).toBe(403)
			await expect(response.text()).resolves.toBe('This account is not authorized')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// Both entries, not just the first — the list spans domains, which is the point of an
		// exact-address gate over a domain one.
		it.each(['ada@example.com', 'grace@elsewhere.com'])(
			'admits %s when the list names it',
			async (email) => {
				userinfoResponse = () =>
					Response.json({ verified_email: true, id: 'google-user-8', name: 'Listed', email })

				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ ALLOWED_EMAILS: 'ada@example.com,grace@elsewhere.com' }),
				)

				expect(response.status).toBe(302)
				expect(completeAuthorization).toHaveBeenCalledOnce()
			},
		)

		// Same reasoning as the domain matrix above: Google hands back a lowercase address in
		// practice, and an access control should not rest on that habit. The comparison is
		// equality on the whole address rather than a suffix, so lowercasing has no lookalike
		// check to weaken here.
		it.each([
			['an address Google sent in mixed case', 'Ada@EXAMPLE.COM', 'ada@example.com'],
			['a list written in mixed case', 'ada@example.com', 'Ada@Example.COM'],
			['both sides in mixed case', 'ADA@Example.com', 'aDa@eXample.COM'],
		])('admits %s', async (_label, email, allowedEmails) => {
			userinfoResponse = () =>
				Response.json({ verified_email: true, id: 'google-user-9', name: 'Ada', email })

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ ALLOWED_EMAILS: allowedEmails }),
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// The comparison is equality on the whole address — `includes` in the gate is
		// Array.prototype's exact-member test, not String's substring search. Pinned from both
		// directions, because refactoring the parsed list back into one string would quietly
		// turn the gate into containment: the first address below is a substring of the listed
		// one, and the listed one is a substring of the second.
		it.each(['da@example.com', 'ada@example.com.attacker.com'])(
			'refuses %s against a list naming exactly ada@example.com',
			async (email) => {
				userinfoResponse = () =>
					Response.json({ verified_email: true, id: 'google-user-14', name: 'Near Miss', email })

				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ ALLOWED_EMAILS: 'ada@example.com' }),
				)

				expect(response.status).toBe(403)
				expect(completeAuthorization).not.toHaveBeenCalled()
			},
		)

		// A human edits this secret by hand, so spaces around the commas are its ordinary
		// shape rather than a malformed value.
		it('tolerates whitespace around the commas', async () => {
			userinfoResponse = () =>
				Response.json({
					verified_email: true,
					id: 'google-user-10',
					name: 'Grace',
					email: 'grace@elsewhere.com',
				})

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ ALLOWED_EMAILS: ' ada@example.com , grace@elsewhere.com ' }),
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// Unset keeps meaning no restriction, and a blank value means the same rather than a
		// list nobody is on: a secret cleared to '' reads as switched off, and the alternative
		// is every sign-in refused by an empty string.
		it.each([
			['unset', undefined],
			['an empty string', ''],
			['only commas and whitespace', ' , ,'],
		])('admits anyone when ALLOWED_EMAILS is %s', async (_label, allowedEmails) => {
			userinfoResponse = () =>
				Response.json({
					verified_email: true,
					id: 'google-user-11',
					name: 'Anyone',
					email: 'anyone@elsewhere.com',
				})

			const response = await callback(
				{ state: validState, code: 'google-code' },
				allowedEmails === undefined ? testEnv() : testEnv({ ALLOWED_EMAILS: allowedEmails }),
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// The two gates apply in the order they sit in the file — the domain first, then the
		// list — and each refusal keeps its own message, which is how an operator tells which
		// gate turned a user away.
		describe('together with HOSTED_DOMAIN', () => {
			it('refuses a listed address outside the hosted domain, with the domain message', async () => {
				userinfoResponse = () =>
					Response.json({
						verified_email: true,
						id: 'google-user-12',
						name: 'Grace',
						email: 'grace@elsewhere.com',
					})

				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ HOSTED_DOMAIN: 'example.com', ALLOWED_EMAILS: 'grace@elsewhere.com' }),
				)

				expect(response.status).toBe(403)
				await expect(response.text()).resolves.toBe(
					'Access restricted to example.com domain users only',
				)
				expect(completeAuthorization).not.toHaveBeenCalled()
			})

			it('refuses an in-domain address the list does not name', async () => {
				userinfoResponse = () =>
					Response.json({
						verified_email: true,
						id: 'google-user-13',
						name: 'Mallory',
						email: 'mallory@example.com',
					})

				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ HOSTED_DOMAIN: 'example.com', ALLOWED_EMAILS: 'ada@example.com' }),
				)

				expect(response.status).toBe(403)
				await expect(response.text()).resolves.toBe('This account is not authorized')
				expect(completeAuthorization).not.toHaveBeenCalled()
			})

			it('admits an in-domain address the list names', async () => {
				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ HOSTED_DOMAIN: 'example.com', ALLOWED_EMAILS: 'ada@example.com' }),
				)

				expect(response.status).toBe(302)
				expect(completeAuthorization).toHaveBeenCalledOnce()
			})
		})
	})

	describe('verified_email', () => {
		// Google does not promise the address is one the account proved it owns — a tenant on
		// an unverified domain can carry any local part at that domain — so an unverified
		// address is refused before either gate compares it.
		it('refuses an address Google reports unverified', async () => {
			userinfoResponse = () =>
				Response.json({
					verified_email: false,
					id: 'google-user-15',
					name: 'Unproven',
					email: 'ada@example.com',
				})

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ ALLOWED_EMAILS: 'ada@example.com' }),
			)

			expect(response.status).toBe(403)
			await expect(response.text()).resolves.toBe('This account is not authorized')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// Compared against `true` rather than tested for falsiness: a userinfo response that
		// stops carrying the field must refuse everyone, not admit everyone.
		it('refuses when the field is missing rather than failing open', async () => {
			userinfoResponse = () =>
				Response.json({ id: 'google-user-16', name: 'Fieldless', email: 'ada@example.com' })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(403)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})
	})

	describe('requireAllowedEmails', () => {
		/** The same fixture identity, stated strict: a blank allowlist is an outage here. */
		const StrictHandler = createGoogleHandler({
			server: { name: 'Momentum Zendesk MCP' },
			requireAllowedEmails: true,
		})

		const strictCallback = (env = testEnv()) =>
			StrictHandler.request(
				`/callback?${new URLSearchParams({ state: validState, code: 'google-code' }).toString()}`,
				{ headers: { cookie: NONCE_COOKIE } },
				env,
			)

		// The refusal is a 503, not a 403: nothing is wrong with the caller, and the fixed
		// sentence tells an unauthenticated stranger nothing about what is unset.
		it.each([
			['unset', undefined],
			['an empty string', ''],
			['only commas and whitespace', ' , ,'],
		])('refuses every sign-in at /callback when ALLOWED_EMAILS is %s', async (_label, raw) => {
			const response = await strictCallback(
				raw === undefined ? testEnv() : testEnv({ ALLOWED_EMAILS: raw }),
			)

			expect(response.status).toBe(503)
			await expect(response.text()).resolves.toBe('Server misconfigured: sign-in is unavailable')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// The same refusal at the front door, so a misconfigured deployment never sends anyone
		// to Google at all. The provider mock is local because the shared /authorize mocks are
		// initialized in that route's own describe, not here.
		it('refuses at /authorize before anyone is sent to Google', async () => {
			const localParseAuthRequest = vi.fn(async () => authRequest)
			const response = await StrictHandler.request(
				`${workerOrigin}/authorize`,
				undefined,
				testEnv({
					OAUTH_PROVIDER: { completeAuthorization, parseAuthRequest: localParseAuthRequest },
				}),
			)

			expect(response.status).toBe(503)
			expect(localParseAuthRequest).not.toHaveBeenCalled()
		})

		// The approval submit must go nowhere either: a dialog rendered before the secret was
		// cleared can still be submitted after.
		it('refuses at POST /authorize before the approval is parsed', async () => {
			vi.mocked(parseRedirectApproval).mockClear()
			const response = await StrictHandler.request(
				`${workerOrigin}/authorize`,
				{ method: 'POST' },
				testEnv({ OAUTH_PROVIDER: { completeAuthorization } }),
			)

			expect(response.status).toBe(503)
			expect(parseRedirectApproval).not.toHaveBeenCalled()
		})

		it('admits a listed address exactly as the lenient handler does', async () => {
			const response = await strictCallback(testEnv({ ALLOWED_EMAILS: 'ada@example.com' }))

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// The flag off is the package default, and every other test in this file runs without
		// it — unset ALLOWED_EMAILS admitting anyone is pinned in the ALLOWED_EMAILS block.
	})

	it('completes the authorization and redirects the client back to its own callback', async () => {
		const response = await callback({ state: validState, code: 'google-code' })

		expect(completeAuthorization).toHaveBeenCalledWith({
			metadata: { label: 'Ada Lovelace' },
			props: {
				accessToken: 'google-access-token',
				email: 'ada@example.com',
				name: 'Ada Lovelace',
			},
			request: authRequest,
			scope: authRequest.scope,
			userId: 'google-user-1',
		})
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(
			'https://client.example.com/oauth/callback?code=granted',
		)
	})

	// This is the test #65 inverted. It used to assert that a hand-built state completed the flow,
	// passing deliberately to record the CSRF property until something fixed it. The nonce is
	// that fix, so the assertion is now the opposite one.
	//
	// The attacker's problem is not the state, which they can write freely — it is the cookie,
	// which they cannot set on someone else's browser. That is why a signature would not have
	// been enough: an attacker can obtain a genuinely signed state by starting their own flow.
	/**
	 * The nonce is what binds a callback to the browser that began the flow, so these are the
	 * tests that carry #65.
	 *
	 * Worth knowing what they cannot show, because it is a real limit rather than a gap to fill
	 * in later. The whole suite drives the handler through `GoogleHandler.request` with a stubbed
	 * `fetch`, so a cookie surviving a real redirect back from Google is not something any of
	 * this demonstrates — these prove the two halves are compared and that the comparison
	 * decides, and a genuine browser round trip stays outside what the suite can reach.
	 */
	describe('the nonce binding the state to this browser', () => {
		it('refuses a state whose nonce does not match the cookie', async () => {
			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv(),
				'mcp-auth-nonce=a-different-browser',
			)

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid state')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// No cookie is the ordinary shape of the attack — the victim's browser never started this
		// flow, so it has nothing to present. It is also what a user with cookies blocked looks
		// like, which is the cost of the check being real rather than decorative.
		it('refuses a state when the browser presents no cookie at all', async () => {
			const response = await callback({ state: validState, code: 'google-code' }, testEnv(), null)

			expect(response.status).toBe(400)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// A state minted before this shipped has no nonce, and so cannot be told apart from one
		// written by hand. Both are refused. A flow in flight across the deploy is the cost, and
		// it is seconds to minutes wide.
		it('refuses a state carrying no nonce at all', async () => {
			const legacy = btoa(JSON.stringify(authRequest))

			const response = await callback({ state: legacy, code: 'google-code' }, testEnv(), null)

			expect(response.status).toBe(400)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('clears the cookie once the nonce has been spent', async () => {
			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(302)
			expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
		})

		// The nonce has done its job by the time the request reaches the provider, and leaving it
		// on would write a spent credential into KV with the grant.
		it('does not pass the nonce on to the provider', async () => {
			await callback({ state: validState, code: 'google-code' })

			expect(completeAuthorization).toHaveBeenCalledWith(
				expect.objectContaining({ request: expect.not.objectContaining({ nonce: NONCE }) }),
			)
		})
	})

	it('refuses a state the server never issued', async () => {
		const forged = btoa(JSON.stringify({ ...authRequest, clientId: 'someone-elses-client' }))

		const response = await callback({ state: forged, code: 'google-code' })

		expect(response.status).toBe(400)
		await expect(response.text()).resolves.toBe('Invalid state')
		expect(completeAuthorization).not.toHaveBeenCalled()
	})
})

describe('/authorize', () => {
	beforeEach(() => {
		parseAuthRequest = vi.fn(async () => authRequest)
		lookupClient = vi.fn(async () => clientInfo)

		// `restoreMocks` in vitest.config.ts reaches vi.spyOn spies, and these three are plain
		// vi.fn mocks handed over by the module factory above — so each is reset here, before
		// its default is set, rather than left to carry calls in from the previous test.
		vi.mocked(clientIdAlreadyApproved).mockReset().mockResolvedValue(false)
		vi.mocked(renderApprovalDialog)
			.mockReset()
			.mockImplementation(() => new Response('<approval dialog>'))
		vi.mocked(parseRedirectApproval)
			.mockReset()
			.mockResolvedValue({
				state: { oauthReqInfo: authRequest },
				headers: { 'set-cookie': 'mcp_approved_clients=signed; Path=/' },
			})
	})

	describe('GET /authorize', () => {
		// parseAuthRequest signals an unregistered client, a redirect URI that does not match the
		// registration, and a dangerous redirect scheme all by throwing, so each one was a bare 500
		// before the catch went in. Asserting the body as well as the status is what proves the
		// route answered: an exception escaping to Hono's onError reads as 500 'Internal Server
		// Error', never as 400 'Invalid authorization request'.
		it('answers 400 when parseAuthRequest rejects the request', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			parseAuthRequest.mockRejectedValue(new Error('Invalid redirect URI for client'))

			const response = await authorize()

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid authorization request')
			expect(clientIdAlreadyApproved).not.toHaveBeenCalled()
			expect(renderApprovalDialog).not.toHaveBeenCalled()
		})

		// Same split as the decode failure on /callback, and the comment on the catch says why: the
		// caller is still unauthenticated here, so the provider's own text goes to the log and the
		// response stays one fixed string. Those messages are static strings today — relaying a
		// dependency's error verbatim only stays safe until a release adds detail to one. The two
		// cases below are the two halves of the ternary that decides what gets logged.
		it.each([
			['an Error', new Error('Invalid redirect URI for client'), 'Invalid redirect URI for client'],
			['a bare string', 'client is not registered', 'client is not registered'],
		])('logs %s thrown by parseAuthRequest without relaying it', async (_label, thrown, logged) => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			parseAuthRequest.mockRejectedValue(thrown)

			const response = await authorize()

			expect(warn).toHaveBeenCalledWith('parseAuthRequest rejected the request:', logged)
			await expect(response.text()).resolves.toBe('Invalid authorization request')
		})

		it('answers 400 when the parsed request carries no clientId', async () => {
			parseAuthRequest.mockResolvedValue({ ...authRequest, clientId: '' })

			const response = await authorize()

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid request')
			expect(renderApprovalDialog).not.toHaveBeenCalled()
		})

		it('skips the dialog and redirects to Google when the client is already approved', async () => {
			vi.mocked(clientIdAlreadyApproved).mockResolvedValue(true)

			const response = await authorize()

			expect(clientIdAlreadyApproved).toHaveBeenCalledWith(
				expect.any(Request),
				'test-client',
				'test-cookie-secret',
			)
			expect(response.status).toBe(302)
			expect(googleUrl(response).hostname).toBe('accounts.google.com')
			expect(renderApprovalDialog).not.toHaveBeenCalled()
		})

		it('renders the approval dialog when the client is not already approved', async () => {
			const response = await authorize()

			expect(lookupClient).toHaveBeenCalledWith('test-client')
			expect(renderApprovalDialog).toHaveBeenCalledWith(
				expect.any(Request),
				expect.objectContaining({ client: clientInfo, state: { oauthReqInfo: authRequest } }),
			)
			expect(response.status).toBe(200)
			await expect(response.text()).resolves.toBe('<approval dialog>')
			expect(response.headers.get('location')).toBeNull()
		})
	})

	describe('POST /authorize', () => {
		it('answers 400 when the approval carries no authorization request', async () => {
			vi.mocked(parseRedirectApproval).mockResolvedValue({ state: {}, headers: {} })

			const response = await approve()

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid request')
		})

		// This route is the cheapest of the three to reach: no Google sign-in, no valid cookie,
		// just a POST. parseRedirectApproval throws on a state that is absent, not a string, not
		// base64 JSON, or carries no clientId, and every one of those was a bare 500 anyone could
		// produce on demand.
		//
		// Asserting the body matters more here than anywhere else in this file, because the module
		// is mocked: coverage counts every statement in the route as exercised whether or not the
		// stub ever rejects, so a green number proves nothing about this path. These two tests are
		// the only evidence the guard exists.
		describe('an approval it cannot parse', () => {
			beforeEach(() => {
				vi.spyOn(console, 'warn').mockImplementation(() => {})
			})

			it.each([
				['the form carried no state', new Error('Missing or invalid state in form data')],
				['the state is not base64 JSON', new Error('Failed to parse approval form: bad input')],
				['a non-Error is thrown', 'a bare string'],
			])('answers 400 rather than 500 when %s', async (_label, thrown) => {
				vi.mocked(parseRedirectApproval).mockRejectedValue(thrown)

				const response = await approve()

				expect(response.status).toBe(400)
				await expect(response.text()).resolves.toBe('Invalid request')
			})

			it('logs the real reason without relaying it to the caller', async () => {
				const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
				vi.mocked(parseRedirectApproval).mockRejectedValue(
					new Error('Failed to parse approval form: not base64'),
				)

				const response = await approve()

				expect(warn).toHaveBeenCalledWith(
					'parseRedirectApproval rejected the request:',
					'Failed to parse approval form: not base64',
				)
				await expect(response.text()).resolves.not.toContain('base64')
			})
		})

		// The #71 pin inverted. It used to assert a 400 here, recording that bare btoa refused
		// any code point above U+00FF until something fixed the encoding — #74 is that fix, so
		// the assertion is now the opposite one: the mint goes through UTF-8 and a caller's own
		// text redirects like any other approval. Decoding the state back out of the consent
		// URL is what proves it round-tripped rather than merely failed to throw.
		it('redirects when the approval carries text bare btoa refused', async () => {
			vi.mocked(parseRedirectApproval).mockResolvedValue({
				state: { oauthReqInfo: { ...authRequest, state: 'Āé😀' } },
				headers: {},
			})

			const response = await approve()

			expect(response.status).toBe(302)
			const url = googleUrl(response)
			expect(url.hostname).toBe('accounts.google.com')
			expect(decodeBase64Json(url.searchParams.get('state')!)).toMatchObject({ state: 'Āé😀' })
		})

		// What is left for the guard is a backstop. Nothing parseRedirectApproval can decode out
		// of a form makes JSON.stringify throw, so driving the catch takes a value JSON refuses
		// outright — and that is the point of keeping the test: whatever manages to throw at the
		// mint next, the answer has to be this 400, never the bare 500 this route once produced.
		it('answers 400 when the approval cannot be encoded as state at all', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			vi.mocked(parseRedirectApproval).mockResolvedValue({
				state: { oauthReqInfo: { ...authRequest, state: BigInt(1) } },
				headers: {},
			})

			const response = await approve()

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid request')
			expect(warn).toHaveBeenCalledWith(
				'The authorization request could not be encoded as state:',
				expect.stringMatching(/./),
			)
		})

		// The headers parseRedirectApproval hands back are the approval cookie, which is the whole
		// point of having approved: without it riding along on this redirect the next authorization
		// asks again. Nothing about the redirect itself would look wrong if it were dropped, so the
		// assertion on set-cookie is doing work the status and location cannot.
		//
		// Two cookies now, and asserting on both is the point rather than thoroughness. This route
		// is the only one that sets more than one, so it is the only place the nonce could have
		// replaced the approval — which is exactly what an object literal keyed by header name
		// would have done, silently, while every other assertion here went on passing.
		it('redirects to Google carrying both the approval cookie and the nonce', async () => {
			const response = await approve()

			expect(parseRedirectApproval).toHaveBeenCalledWith(expect.any(Request), 'test-cookie-secret')
			expect(response.status).toBe(302)
			expect(googleUrl(response).hostname).toBe('accounts.google.com')

			const cookies = response.headers.getSetCookie()
			expect(cookies).toContain('mcp_approved_clients=signed; Path=/')
			expect(cookies).toHaveLength(2)
			expect(cookies.some((cookie) => cookie.startsWith('mcp-auth-nonce='))).toBe(true)
		})
	})

	describe('the Google consent URL it redirects to', () => {
		beforeEach(() => {
			vi.mocked(clientIdAlreadyApproved).mockResolvedValue(true)
		})

		// Google refuses the request outright if any of these is missing or wrong, so a redirect
		// that has lost one fails at the consent screen rather than here.
		it('carries the client id, redirect URI, scope, response type and state', async () => {
			const url = googleUrl(await authorize())

			expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
			expect(url.searchParams.get('client_id')).toBe('test-google-client-id')
			expect(url.searchParams.get('redirect_uri')).toBe(`${workerOrigin}/callback`)
			expect(url.searchParams.get('scope')).toBe('email profile')
			expect(url.searchParams.get('response_type')).toBe('code')
			// The state carries the authorization request the callback will read back, which is
			// what makes the two halves of the flow one flow rather than two that happen to
			// agree. It can no longer be compared to a fixed string, because the nonce in it is
			// fresh per flow — so the request fields are checked, and the nonce separately below.
			expect(JSON.parse(atob(url.searchParams.get('state')!))).toMatchObject(authRequest)
		})

		// The binding itself, asserted as the one fact that matters: the nonce Google is asked to
		// hand back is the same one this browser was just given. Checking either alone would pass
		// while the two were generated independently, which is the mistake that would leave every
		// legitimate sign-in failing and every forged one failing for the wrong reason.
		it('mints a nonce that matches the cookie it sets', async () => {
			const response = await authorize()

			const state = JSON.parse(atob(googleUrl(response).searchParams.get('state')!))
			const cookie = response.headers
				.getSetCookie()
				.find((value) => value.startsWith('mcp-auth-nonce='))!

			expect(typeof state.nonce).toBe('string')
			expect(state.nonce).not.toHaveLength(0)
			expect(cookie).toContain(`mcp-auth-nonce=${state.nonce};`)
			expect(cookie).toContain('HttpOnly')
			expect(cookie).toContain('Secure')
			// Lax rather than Strict, because the return from Google is a cross-site top-level
			// navigation. Strict would drop the cookie and refuse every sign-in.
			expect(cookie).toContain('SameSite=Lax')
			expect(cookie).toContain('Max-Age=1800')
		})

		// The callback is built from whichever host the request arrived on, which README documents
		// because of how it fails when Google does not know that host: every endpoint on the worker
		// goes on answering normally and the flow dies at the consent screen with
		// redirect_uri_mismatch. So connecting through a custom domain needs that domain registered
		// too, and registering the workers.dev hostname alone is not enough.
		it.each([
			['the workers.dev hostname', workerOrigin],
			['a custom domain', 'https://zendesk.example.com'],
		])('builds the redirect URI from %s the request arrived on', async (_label, origin) => {
			const url = googleUrl(await authorize(authorizeEnv(), origin))

			expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/callback`)
		})

		it('carries hd when HOSTED_DOMAIN is set', async () => {
			const url = googleUrl(await authorize(authorizeEnv({ HOSTED_DOMAIN: 'example.com' })))

			expect(url.searchParams.get('hd')).toBe('example.com')
		})

		it('leaves hd off when HOSTED_DOMAIN is unset', async () => {
			const url = googleUrl(await authorize())

			expect(url.searchParams.has('hd')).toBe(false)
		})
	})
})
