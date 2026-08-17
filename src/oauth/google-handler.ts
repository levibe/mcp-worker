import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { type Context, Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from './upstream'
import { decodeBase64Json, encodeBase64Json } from './base64'
import { isRecord } from './narrow'
import {
	clientIdAlreadyApproved,
	parseRedirectApproval,
	renderApprovalDialog,
} from './workers-oauth-utils'

/**
 * What to write to the log about a thrown value, whatever it turned out to be.
 *
 * Every route here catches something it cannot answer and logs the reason while telling the
 * caller a fixed sentence, so this expression appeared five times. Once is better for an
 * ordinary reason — one place to change if the wording moves — and for one that is specific to
 * this file: the `String` arm is unreachable from most of those catches, since `atob`,
 * `JSON.parse` and `btoa` all throw real `Error`s. Written inline it was five branch pairs of
 * which only one could ever be exercised, so coverage on this file measured the reachability of
 * a ternary rather than whether the guards around it were tested.
 */
const reasonFor = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

/**
 * The cookie holding the nonce that binds a callback to the browser that started the flow.
 *
 * `SameSite=Lax` rather than `Strict`, and that is required rather than a preference: the return
 * from Google is a top-level GET navigation from another site, which `Lax` permits and `Strict`
 * would drop — making every sign-in fail rather than only the forged ones.
 */
const STATE_NONCE_COOKIE = 'mcp-auth-nonce'

/**
 * How long the browser has to finish at Google, in seconds.
 *
 * This is the time a user may sit on the consent screen before their sign-in is refused, so it
 * is a usability number as much as a security one. Thirty minutes survives a genuine
 * interruption. The window is the weaker of the two controls in any case: the nonce is random
 * per flow and cleared the moment it is used, so what this bounds is only how long an abandoned
 * flow stays replayable by the browser that abandoned it.
 */
const STATE_NONCE_MAX_AGE_SECONDS = 1_800

const nonceCookie = (value: string, maxAgeSeconds: number) =>
	`${STATE_NONCE_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`

/**
 * What the consumer's `Env` must supply — secrets only, no bindings. This is the shape
 * `createMcpWorker` constrains its env type on, so it deliberately does not name
 * `OAUTH_PROVIDER`: the wrangler-generated `Env` never declares that binding and should
 * not, because the OAuth provider injects it per request.
 */
export interface GoogleHandlerSecrets {
	COOKIE_ENCRYPTION_KEY: string
	GOOGLE_CLIENT_ID: string
	GOOGLE_CLIENT_SECRET: string
	HOSTED_DOMAIN?: string
	/**
	 * Comma-separated exact addresses admitted at the OAuth callback; unset or blank admits
	 * anyone. Entries are trimmed, empty ones dropped, and the comparison is case-insensitive
	 * equality on the whole address.
	 *
	 * The knob exists for consumers whose authorized users are not on a single hosted domain.
	 * A gmail.com address shares its domain with every personal Google account, so
	 * HOSTED_DOMAIN cannot admit one such user without admitting them all — restriction has
	 * to be by exact address. When both are set, a sign-in must clear both checks.
	 */
	ALLOWED_EMAILS?: string
}

/** The Hono app's actual bindings: the secrets plus the provider's injected helpers. */
export type GoogleHandlerEnv = GoogleHandlerSecrets & { OAUTH_PROVIDER: OAuthHelpers }

export interface GoogleHandlerOptions {
	/** Shown on the approval dialog — the product identity, which is the only thing in this
	 *  flow that is the app's rather than the mechanism's. */
	server: { name: string; description?: string; logo?: string }
	/**
	 * When true, a blank or unset ALLOWED_EMAILS refuses every sign-in rather than admitting
	 * everyone. The package default stays opt-in because a consumer may legitimately run an
	 * unrestricted gate; a deployment whose tools read someone's whole mailbox states this
	 * and gets a misconfiguration answered as an outage instead of an open door.
	 */
	requireAllowedEmails?: boolean
}

/**
 * ALLOWED_EMAILS as compared: entries trimmed, lowercased, empties dropped. One parser for
 * the requireAllowedEmails check and the callback gate, so the two cannot drift on what
 * counts as a configured list.
 */
const parseAllowedEmails = (raw: string | undefined): string[] =>
	(raw ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry !== '')

export const createGoogleHandler = (options: GoogleHandlerOptions) => {
	const app = new Hono<{ Bindings: GoogleHandlerEnv }>()

	/**
	 * The requireAllowedEmails refusal, asked at both doors: /authorize so a misconfigured
	 * deployment refuses before anyone is sent to Google, and /callback so a flow already in
	 * flight when the secret was cleared cannot land past the gate. Logged per affected
	 * request, the way a fallen-closed TOOL_CEILINGS is, because the caller's fixed sentence
	 * deliberately says nothing an unauthenticated stranger could use.
	 */
	const refuseUnconfiguredAllowlist = (c: Context<{ Bindings: GoogleHandlerEnv }>) => {
		if (!options.requireAllowedEmails || parseAllowedEmails(c.env.ALLOWED_EMAILS).length > 0) {
			return undefined
		}
		console.error(
			'ALLOWED_EMAILS is unset or blank and this deployment requires it; refusing sign-in',
		)
		return c.text('Server misconfigured: sign-in is unavailable', 503)
	}

	app.get('/authorize', async (c) => {
		const refused = refuseUnconfiguredAllowlist(c)
		if (refused) return refused
		// parseAuthRequest rejects an unregistered client, a redirect URI that doesn't match
		// the registration, and dangerous redirect schemes. It signals all of these by throwing,
		// so without this catch they surface as a bare 500 that tells the client nothing.
		//
		// The caller is still unauthenticated here, so it gets a fixed message and the provider's
		// own text goes to the log instead. Those messages are static strings today, but relaying
		// a dependency's error verbatim only stays safe until a release adds detail to one.
		let oauthReqInfo: AuthRequest
		try {
			oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
		} catch (error) {
			console.warn('parseAuthRequest rejected the request:', reasonFor(error))
			return c.text('Invalid authorization request', 400)
		}

		const { clientId } = oauthReqInfo
		if (!clientId) {
			return c.text('Invalid request', 400)
		}

		if (
			await clientIdAlreadyApproved(c.req.raw, oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY)
		) {
			return redirectToGoogle(c, oauthReqInfo)
		}

		return renderApprovalDialog(c.req.raw, {
			client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
			server: options.server,
			state: { oauthReqInfo },
		})
	})

	app.post('/authorize', async (c) => {
		// Guarded for the same reason as the two catches in /callback, and this is the one a caller
		// reaches most cheaply of the three: no Google sign-in, no valid cookie, nothing. A form body
		// whose `state` is absent, is not a string, is not base64 JSON, or decodes without a
		// `clientId` makes `parseRedirectApproval` throw, and an unhandled throw is answered by Hono
		// as a bare 500.
		//
		// Not only forged input lands here, and the 400 is a deliberate simplification rather than a
		// claim. `parseRedirectApproval` calls `importKey`, which throws when COOKIE_ENCRYPTION_KEY
		// is missing — a misconfigured deployment, reported to the caller as their mistake. The log
		// line carries the real reason, so nothing is lost, but do not read this catch as proof that
		// a 400 from this route means the request was bad.
		//
		// Worth knowing when reading coverage on this file: it reports every statement here as
		// covered, because the tests replace `parseRedirectApproval` with a stub that resolves. A
		// green number is not evidence this route is guarded — the test that proves it is the one
		// making that stub reject.
		let approval: Awaited<ReturnType<typeof parseRedirectApproval>>
		try {
			approval = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY)
		} catch (error) {
			console.warn('parseRedirectApproval rejected the request:', reasonFor(error))
			return c.text('Invalid request', 400)
		}

		const { state, headers } = approval
		if (!state.oauthReqInfo) {
			return c.text('Invalid request', 400)
		}

		// Not a claim the shape has been established: parseRedirectApproval checked
		// `oauthReqInfo.clientId` and nothing else, so the rest of this object is the form's
		// claim. It is also a deliberately weaker statement than the cast /callback makes below —
		// that value is read field by field inside completeAuthorization, while this one is only
		// ever spread into encodeBase64Json, riding to Google as opaque state and re-checked on
		// the way back, where /callback narrows it again and the provider validates the fields
		// that matter.
		return redirectToGoogle(c, state.oauthReqInfo as AuthRequest, headers)
	})

	async function redirectToGoogle(
		c: Context,
		oauthReqInfo: AuthRequest,
		headers: Record<string, string> = {},
	) {
		// The state is minted through encodeBase64Json, which goes through UTF-8, so a caller's own
		// text survives the trip whatever characters it carries. That matters here because this is
		// the one place that text reaches the encoding: OAuth `state` is opaque client data, and on
		// POST /authorize the object below comes straight out of the form body, with nothing
		// upstream inspecting it beyond requiring a truthy `clientId`.
		//
		// The guard stays as a backstop rather than the control it once was. Encoding can still
		// throw in principle — JSON.stringify refuses a value it cannot serialize — and nothing that
		// decoded from a form can produce one, but that certainty is exactly what a backstop exists
		// not to lean on: an uncaught throw here is a bare 500 anyone could probe for with one form
		// field and no sign-in at all.
		// The nonce is what makes the state belong to this browser. It goes into the state Google
		// hands back and into a cookie only this browser holds, and `/callback` requires the two to
		// agree — so a state minted somewhere else no longer completes a flow here.
		//
		// It has to be the cookie doing this rather than a signature. An HMAC would prove the state
		// is one we minted, and an attacker can obtain a genuinely minted state simply by starting a
		// flow of their own, so signing detects tampering and stops none of the attack. What the
		// attacker cannot do is set a cookie on someone else's browser.
		const nonce = crypto.randomUUID()

		let state: string
		try {
			state = encodeBase64Json({ ...oauthReqInfo, nonce })
		} catch (error) {
			console.warn('The authorization request could not be encoded as state:', reasonFor(error))
			return c.text('Invalid request', 400)
		}

		// A `Headers` rather than an object literal, and the reason is a real trap. `headers` may
		// already carry the approval cookie from POST /authorize, and a second `Set-Cookie` key on a
		// plain object would replace it rather than accompany it — silently signing the user out of
		// their approval to fix a CSRF hole. `append` is what allows two of them.
		// Note this stays a `Headers` all the way into the Response. Flattening it back through
		// `Object.fromEntries` would undo the whole point, because object keys are unique and the
		// two cookies would collapse to one again.
		const responseHeaders = new Headers(headers)
		responseHeaders.append('Set-Cookie', nonceCookie(nonce, STATE_NONCE_MAX_AGE_SECONDS))
		responseHeaders.set(
			'location',
			getUpstreamAuthorizeUrl({
				clientId: c.env.GOOGLE_CLIENT_ID,
				hostedDomain: c.env.HOSTED_DOMAIN,
				redirectUri: new URL('/callback', c.req.raw.url).href,
				scope: 'email profile',
				state,
				upstreamUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			}),
		)

		return new Response(null, {
			headers: responseHeaders,
			status: 302,
		})
	}

	/**
	 * Exchanges Google's code for an access token, completes the authorization, and redirects the
	 * client back to its own callback. What goes into `props` is encrypted into the access token
	 * and is what a tool can later read through `getMcpAuthContext()` — see `Props` in ./upstream.
	 */
	app.get('/callback', async (c) => {
		const refused = refuseUnconfiguredAllowlist(c)
		if (refused) return refused

		// The `state` here is what redirectToGoogle minted: the authorization request plus a nonce,
		// base64 of JSON and still neither signed nor encrypted. It does not need to be. What the
		// OAuth `state` parameter exists to do is bind the callback to the browser that started the
		// flow, and the nonce check below does that against a cookie only that browser holds.
		//
		// Without it this was the shape of an authorization-code injection: an attacker starts a flow
		// of their own, then hands the victim a callback URL that binds the attacker's Google identity
		// to the victim's MCP client session. #65 has the argument and the test that used to record
		// the hole is now inverted to record the fix.
		//
		// Encrypting the state would still buy nothing, and it is worth saying so because the state
		// being readable looks like the problem and is not. It carries the client's own authorization
		// request, which that client already knows; the security property is that a state cannot be
		// used from a browser other than the one it was minted for.
		//
		// Everything below arrived through the user's browser and none of it can be assumed
		// well-formed. `state` may be absent, and `decodeBase64Json` throws on anything that is not
		// base64 or does not parse as JSON — on a public, unauthenticated endpoint all three used to
		// be a bare 500 that anyone could produce at will. Handled the way GET
		// /authorize handles parseAuthRequest above, and for the same reason: the real cause goes to
		// the log, and the unauthenticated caller gets one fixed message that does not tell it which
		// step it managed to break.
		const encodedState = c.req.query('state')
		if (!encodedState) {
			return c.text('Invalid state', 400)
		}

		let decodedState: unknown
		try {
			decodedState = decodeBase64Json(encodedState)
		} catch (error) {
			console.warn('Callback state could not be decoded:', reasonFor(error))
			return c.text('Invalid state', 400)
		}

		// Narrow before reading a property off it. `JSON.parse` returns whatever the JSON said, which
		// includes `null` and bare scalars, so reading `.clientId` straight off the result would let
		// a state of `btoa('null')` throw the same unhandled TypeError in through a different door.
		// The clientId check is the one that was already here; it just needs something to stand on.
		if (
			!isRecord(decodedState) ||
			typeof decodedState.clientId !== 'string' ||
			!decodedState.clientId
		) {
			return c.text('Invalid state', 400)
		}

		// The nonce check, and the one thing here that makes a forged state fail. Everything above
		// establishes that the state is well-formed; this establishes that it belongs to the browser
		// presenting it, which is the property an authorization-code injection has to break.
		//
		// Both halves are required. A state with no nonce is one minted before this existed, or one
		// an attacker wrote by hand — treated the same, because neither can show the cookie. A
		// cookie with no state to match is the same failure from the other side.
		//
		// A plain comparison rather than a constant-time one. What is compared is a random v4 UUID
		// that lives for one flow, so there is no secret to recover a byte at a time, and the
		// attacker cannot replay what they learn against another browser anyway.
		const presentedNonce = getCookie(c, STATE_NONCE_COOKIE)
		if (
			typeof decodedState.nonce !== 'string' ||
			!presentedNonce ||
			presentedNonce !== decodedState.nonce
		) {
			console.warn('Callback state did not match the nonce cookie for this browser')
			return c.text('Invalid state', 400)
		}

		// The nonce comes back off before the request goes any further. `completeAuthorization`
		// writes this object onto the grant, and the nonce has done its job by now — keeping it
		// would persist a spent credential into KV for no reason.
		delete decodedState.nonce

		// The step through `unknown` is required rather than lazy: `AuthRequest` is an interface, so
		// it carries no implicit index signature and TypeScript will not convert the narrowed record
		// to it directly.
		//
		// What is checked above is `clientId` and nothing else, and the rest of this object is forged
		// input all the way to `completeAuthorization`. Do not read the cast as a claim that the
		// shape has been established — several of its fields are read on the way there, `scope` two
		// lines below and `redirectUri`, `responseType`, `resource`, `state`, `codeChallenge` and
		// `codeChallengeMethod` inside the provider.
		//
		// The last two are the ones worth knowing about, because they are the PKCE binding and the
		// provider copies them onto the grant without checking. A forged state omitting
		// `codeChallenge` therefore mints a grant with no PKCE on it. That is not exploitable on its
		// own here — the redirect URI still has to be one the client registered, so the code goes
		// back to the real client — but it is the sharpest illustration of how much of this object
		// is load-bearing and how little of it anything has checked by this point.
		const oauthReqInfo = decodedState as unknown as AuthRequest

		// Exchange the code for an access token
		const code = c.req.query('code')
		if (!code) {
			return c.text('Missing code', 400)
		}

		const [accessToken, googleErrResponse] = await fetchUpstreamAuthToken({
			clientId: c.env.GOOGLE_CLIENT_ID,
			clientSecret: c.env.GOOGLE_CLIENT_SECRET,
			code,
			grantType: 'authorization_code',
			redirectUri: new URL('/callback', c.req.url).href,
			upstreamUrl: 'https://accounts.google.com/o/oauth2/token',
		})
		if (googleErrResponse) {
			return googleErrResponse
		}

		const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})
		if (!userResponse.ok) {
			return c.text(`Failed to fetch user info: ${await userResponse.text()}`, 500)
		}

		const {
			id,
			name,
			email,
			verified_email: verifiedEmail,
		} = (await userResponse.json()) as {
			id: string
			name: string
			email: string
			verified_email?: boolean
		}

		// Refuse an address Google has not confirmed the signer-in owns.
		//
		// Both gates below compare this string, and it rides into `props` as the caller's
		// identity, so it is the one value in this flow an access control cannot take on trust.
		// Google does not promise the address is one the account proved it owns: a Workspace or
		// Cloud Identity tenant on a domain whose ownership is still unverified can carry any
		// local part at that domain, and Google reports `verified_email: false` for it. Their
		// own guidance is not to treat the address as an identifier until the flag is true.
		//
		// Compared against `true` rather than tested for falsiness, so a response that stops
		// carrying the field refuses everyone rather than admitting everyone — for a gate that
		// is the right side to fail on, and it fails loudly enough to be noticed. The caller
		// gets a fixed sentence and the reason goes to the log, matching how the rest of this
		// file answers an unauthenticated caller.
		if (verifiedEmail !== true) {
			console.warn(`Google reported the address as unverified; refusing sign-in for '${email}'`)
			return c.text('This account is not authorized', 403)
		}

		// Enforce domain restriction if HOSTED_DOMAIN is set.
		//
		// Both sides are lowercased before comparing. A domain is case-insensitive by definition,
		// and the local part is not, but neither is compared here — the suffix being matched starts
		// at the `@`, so lowercasing the whole address cannot make two different mailboxes look
		// alike. Google normally hands back a lowercase `email`, so this is not a bug anyone was
		// hitting; it is an access control that should not depend on a habit of the identity
		// provider's, since the failure it would produce is a refusal that looks arbitrary.
		//
		// Keep the `@`. Matching the bare domain would admit `ada@notexample.com` against a hosted
		// domain of `example.com`, and there is a test pinning exactly that.
		const hostedDomain = c.env.HOSTED_DOMAIN?.toLowerCase()
		if (hostedDomain && !email.toLowerCase().endsWith(`@${hostedDomain}`)) {
			return c.text(`Access restricted to ${c.env.HOSTED_DOMAIN} domain users only`, 403)
		}

		// Enforce the exact-address allowlist if ALLOWED_EMAILS is set.
		//
		// It runs after the domain check, so when both are set a sign-in has to clear both, the
		// domain first. `parseAllowedEmails` trims entries and drops empty ones before the list
		// is judged non-empty — a human edits this secret by hand, and a stray space or trailing
		// comma must neither refuse everyone nor quietly admit the empty string. A value that is
		// blank once parsed means no restriction, the same as unset (unless requireAllowedEmails
		// already refused above).
		//
		// Both sides are lowercased for the same reason as the domain above: Google hands back
		// a lowercase address in practice, and an access control should not rest on that habit.
		// Here the comparison is equality on the whole address rather than a suffix, so there
		// is no lookalike hazard for lowercasing to weaken.
		//
		// The refusal names no addresses, unlike the domain message above. A hosted domain is
		// an organization's public name; this list is private addresses, and an unauthenticated
		// caller does not get it echoed back.
		const allowedEmails = parseAllowedEmails(c.env.ALLOWED_EMAILS)
		if (allowedEmails.length > 0 && !allowedEmails.includes(email.toLowerCase())) {
			return c.text('This account is not authorized', 403)
		}

		// Return back to the MCP client a new token.
		//
		// Wrapped for the same reason the state decode above is, and it is the last place a forged
		// state can still reach. This object is validated here and nowhere earlier: the provider
		// throws when `redirectUri` is missing, when the client is not registered, and when the
		// redirect URI is not one that client registered. Those three checks are the ones that
		// matter and they hold — there is no open redirect here — but the provider signals all of
		// them by throwing, and nothing upstream catches it, so an unhandled throw is answered by
		// Hono as a bare 500. The barrier to producing one at will was a Google sign-in and nothing
		// more. A fixed 400 is the honest answer to a state we accepted only as far as its clientId,
		// and the real reason goes to the log where the caller cannot read it.
		//
		// Do not add `scope` to the list of things the provider refuses. `options.scope.join(' ')`
		// runs only on the implicit-grant branch, and every client here uses `responseType: 'code'`,
		// where scope is written onto the grant unexamined and an absent one simply drops the key.
		//
		// The same caveat as the catch on POST /authorize: this is not only forged input. The
		// provider reads and writes KV throughout, so an outage answers 400 here and shows up as a
		// 4xx spike rather than a 5xx one. The reason reaches the log either way.
		let redirectTo: string
		try {
			;({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
				metadata: {
					label: name,
				},
				props: {
					accessToken,
					email,
					name,
				} as Props,
				request: oauthReqInfo,
				scope: oauthReqInfo.scope,
				userId: id,
			}))
		} catch (error) {
			// Error rather than warn, and the only catch in this file at that level. Adding it is what
			// took a provider outage from an uncaught 500 to a 400, so anything alerting on 5xx went
			// quiet at the same moment; the level is what is left to notice one by.
			//
			// The two catches on /authorize stay at warn deliberately, even though they absorb
			// infrastructure failures too. Both are reachable by anyone with no sign-in at all, so
			// raising them would let a stream of forged requests bury the outages this is meant to
			// surface. Reaching here costs a completed Google sign-in, which bounds that.
			console.error('completeAuthorization rejected the request:', reasonFor(error))
			return c.text('Invalid authorization request', 400)
		}

		// The nonce is spent, so it is cleared here rather than left to expire. Without this it stays
		// valid in this browser for the rest of its `Max-Age`, and the state that matches it is
		// sitting in that browser's history — so a back-button replay would complete the flow a
		// second time. `Response.redirect` gives an immutable response, hence building it by hand.
		return new Response(null, {
			headers: {
				location: redirectTo,
				'Set-Cookie': nonceCookie('', 0),
			},
			status: 302,
		})
	})

	return app
}
