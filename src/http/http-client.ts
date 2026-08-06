/**
 * The retrying HTTP transport, extracted from the Zendesk client so any API client can wrap
 * it (#93). It knows nothing about any particular API: the base URL, the Authorization
 * header, and the product name its error messages carry all arrive as options. What it owns
 * is the request mechanics and the retry policy — one deadline over every attempt, a
 * verb-decided retryable set, `Retry-After` honored and never undercut — and the policy is
 * deliberately not configurable. The status sets and tuning constants below carry their own
 * arguments, and a consumer that could override them would leave those arguments holding
 * nothing. A knob gets added here when a consumer argues for one, not before.
 */

export interface HttpClientOptions {
	/** Absolute URL prefix; endpoint strings are appended to it exactly as written. */
	baseUrl: string
	/**
	 * Returns the Authorization header value. Called first on every attempt, outside the
	 * `try`, so a throw from it is a plain error the classifier never retries — which makes
	 * this the right home for a credential check: a missing token fails once, immediately,
	 * rather than being asked again as if a connection had dropped.
	 */
	authHeader: () => string
	/** The product name error messages lead with: `${label} API Error: 404 - …`. */
	label: string
	/**
	 * An extra sentence for the cross-host redirect message, naming the configuration to fix
	 * — a renamed tenant is what such a redirect usually means. Omitted, the message still
	 * names the host and says why the redirect was not followed.
	 */
	redirectHint?: string
}

/**
 * What `request` throws. `status` is the HTTP status when the server answered and undefined
 * when it did not, which is the distinction the retry policy turns on: a status means the
 * server replied and said no, no status means the request never completed.
 *
 * It exists so that the status survives being turned into a sentence. `request` builds its
 * message out of the response body, and the classifier used to search that message for '429'
 * and friends — which cannot tell a status from the same three digits quoted in a body.
 *
 * `retryAfterMs` is there for the same reason and carries the same kind of fact: something
 * the response said that the message would otherwise throw away. It holds what `Retry-After`
 * asked for, and is undefined when the response did not ask for anything usable.
 */
export class HttpRequestError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'HttpRequestError'
	}
}

/**
 * How long `Retry-After` asked us to wait, in milliseconds, or undefined if it said nothing
 * usable.
 *
 * The header is defined as either a whole number of seconds or an HTTP date. Zendesk sends
 * seconds, and both are read anyway — the date form costs four lines, and implementing half
 * a header without saying so is a worse thing to leave behind than the four lines.
 */
function parseRetryAfter(header: string | null): number | undefined {
	if (!header) {
		return undefined
	}

	const value = header.trim()
	let wait: number

	if (/^\d+$/.test(value)) {
		// The numeric form is a whole number of seconds. Matched with a regex rather than
		// passed to Number(), which would also read '1e3' and '0x10' as a count of seconds.
		wait = Number(value) * 1000
	} else {
		// Otherwise an HTTP date. `Date.parse` is far looser here than it looks — it reads
		// '-5' as May 2001 and '120' as the year 120 — so it cannot be relied on to reject
		// nonsense. What makes that safe is the check below, not a tighter pattern up here.
		const when = Date.parse(value)
		if (Number.isNaN(when)) {
			return undefined
		}
		wait = when - Date.now()
	}

	// Only a wait in the future is usable. A header resolving to zero or to the past tells us
	// nothing about how long to hold off, and reading it as "retry now" would be the single
	// worst answer available: asking again immediately against a quota already exhausted.
	// Falling back to the caller's own backoff is safer, and is what an absent header does.
	return wait > 0 ? wait : undefined
}

/**
 * Builds the error for a failure that a response is already in hand for.
 *
 * The status is what the retry policy classifies on, and an error missing one means something
 * specific to it: the request went out and nothing came back, so send it again. Every failure
 * raised once a response has arrived therefore has to carry the status it arrived with, or a
 * refusal the server stated plainly gets retried on the strength of a body we could not read.
 *
 * That held before this existed, but only because three separate sites each remembered to pass
 * the same two things. Four instances of forgetting turned up while #29, #31 and #32 were being
 * written, every one found by accident rather than by looking, and the last of them survived
 * three rounds of review aimed at this exact mistake. Taking the `Response` rather than the two
 * values read off it is what makes the omission unavailable: there is no argument to leave out.
 *
 * `Retry-After` is read here for every caller, including the ones whose status can never be
 * retried. Uniform is worth more than precise — the header is meaningless on a 3xx and on the
 * 200 whose body would not parse, and reading it costs nothing, where letting each site decide
 * is how one of them came to omit it for no reason it could state.
 *
 * The rewrap in the outer catch is deliberately not built through this. It describes whatever it
 * caught rather than a response, and it has no `Response` to hand — carrying the status forward
 * when there is one is exactly its job.
 */
function errorFromResponse(response: Response, message: string, cause?: unknown) {
	return new HttpRequestError(
		message,
		response.status,
		parseRetryAfter(response.headers.get('retry-after')),
		cause !== undefined ? { cause } : undefined
	)
}

/**
 * Statuses where the server is asking to be called back rather than refusing the request.
 *
 * 408 is in because it means the request timed out on their side and is worth sending again.
 *
 * 500 is out, for the opposite reason: it is a fault that will fail the same way on a second
 * attempt. 502, 503 and 504 mean the request never reached a healthy backend at all.
 *
 * This set is what a read may retry. A write answers to the narrower one below.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504])

/**
 * The subset a write may retry: the refusals that cannot have acted on the request.
 *
 * A rate limit is the server declining to start the work, and a 408 is the server giving up
 * before the request had finished arriving. Neither can have created anything, so sending one
 * again is exactly as safe as sending a `GET` again.
 *
 * The other three are excluded because they are ambiguous rather than because they are severe,
 * which is the distinction worth keeping hold of. A 504 means a gateway stopped waiting for a
 * backend that may well have gone on to finish the work. These endpoints take no idempotency
 * key, so nothing here can tell that from a backend that never got it, and asking again makes
 * the second ticket. The client cannot make an ambiguous retry safe; it can only decline it.
 *
 * Do not read this as a severity ranking and add 500 to the read set to match — 500 is out of
 * both for a different reason, that it will fail the same way next time.
 */
const RETRYABLE_STATUSES_FOR_WRITES = new Set([408, 429])

/** How long a single `request` waits for an answer when nothing narrower bounds it. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long a whole `requestWithRetry` call gets — every attempt and every backoff together.
 *
 * Set to the same figure as one attempt, which keeps the worst case exactly where it already
 * was: a caller never waits longer than it does today. Before #24 that was also the real
 * worst case, because a timed-out request was never retried; #24 fixed the classifier and
 * the arithmetic followed it to three attempts and two backoffs, about 93 seconds. That is
 * longer than most clients will wait, so the likely outcome was the caller giving up first
 * and the remaining attempts running for nobody.
 *
 * What this buys is that retries stop costing wall-clock time the caller can feel. The case
 * they exist for still works: a 503 answered in 200ms gets all three attempts inside four
 * seconds. What they no longer do is stack full-length timeouts — a genuinely hung endpoint
 * spends the budget on its first attempt and fails at 30 seconds, which is what it did
 * before retrying timeouts was possible at all.
 */
const TOTAL_TIMEOUT_MS = 30_000

/**
 * The smallest window worth starting an attempt in.
 *
 * Without it, "does another attempt fit" is answered after the fact: the loop sleeps through
 * its backoff, starts a request with 40 milliseconds left, and that request is aborted on
 * arrival. A second is a low bar, and clearing it is not a promise the attempt will finish —
 * only that it was not doomed before it was sent.
 */
const MINIMUM_ATTEMPT_MS = 1_000

/**
 * How many attempts a retried call gets in total.
 *
 * A constant rather than a parameter because it is a tuning decision like the three above it,
 * and nothing has ever wanted a different number — it sat in `requestWithRetry`'s signature
 * for long enough to collide with `request`'s `timeoutMs`, which is #55.
 *
 * It is the backstop for failures that arrive instantly, and only for those. Once an attempt
 * takes real time the deadline decides and this never binds. Removing it would not simplify
 * as much as it looks: instant failures still sleep the backoff ladder, so the deadline alone
 * would permit about eight of them rather than three, and a hard-down backend would be asked
 * eight times per call instead of three.
 */
const MAX_ATTEMPTS = 3

/**
 * The window a retry may land in after a `Retry-After` wait — somewhere in the second past
 * the moment the server named, and never a millisecond before it. Asking earlier than agreed
 * spends more of a quota already exhausted, so the spread only ever adds.
 *
 * One second because the header speaks in whole seconds: every caller refused together is
 * told the same figure, so a spread as wide as the granularity is what separates them
 * completely. Flat rather than scaled to the wait, because a wider window buys no more
 * separation and eats more of a deadline the wait itself already dominates.
 */
const RETRY_AFTER_SPREAD_MS = 1_000

/**
 * Yields an error and then each `cause` beneath it. `request` rewraps whatever it caught, so
 * the failure worth classifying is usually a link or two down rather than in hand — and fetch
 * itself nests, reporting a socket error as the cause of a bare "fetch failed".
 *
 * The depth cap is only there so a self-referential chain cannot hang the retry loop.
 */
function* causeChain(error: unknown, maxDepth = 10): Generator<Error> {
	let current = error
	for (let depth = 0; depth < maxDepth && current instanceof Error; depth += 1) {
		yield current
		current = current.cause
	}
}

/**
 * The wait the server asked for, if any link in the chain carries one. Walks it for the same
 * reason the classifier does: `request` rewraps, so the answer sits a link or two down.
 */
function retryAfterFrom(error: unknown): number | undefined {
	for (const link of causeChain(error)) {
		if (link instanceof HttpRequestError && link.retryAfterMs !== undefined) {
			return link.retryAfterMs
		}
	}
	return undefined
}

/**
 * What to say about a redirect this client declined to follow.
 *
 * The two cases have different causes and different fixes, so they get different sentences.
 * A hop to another host is what a renamed tenant looks like, and it is the one the platform
 * would have stripped the credential from — `redirectHint` is where the app names the
 * configuration to update. A redirect that stays on the same host would have been safe to
 * follow, so saying that keeps an unexpected one from reading as the credential problem it
 * is not.
 *
 * Re-attaching the credential and following on is deliberately not an option here. That
 * would mean deciding the new host is trustworthy, which is the judgement the platform
 * default exists to stop `fetch` making on its own.
 */
function describeRedirect(response: Response, requestUrl: URL, redirectHint?: string): string {
	const location = response.headers.get('location')
	if (!location) {
		return 'redirected without naming a destination, and redirects are not followed.'
	}

	let target: URL
	try {
		target = new URL(location, requestUrl)
	} catch {
		return `redirected to "${location}", which is not a URL. Redirects are not followed.`
	}

	if (target.host !== requestUrl.host) {
		return (
			`redirected to ${target.host}. Redirects are not followed, because the Authorization ` +
			`header does not survive a hop to another host.` +
			(redirectHint ? ` ${redirectHint}` : '')
		)
	}

	return `redirected to ${target.pathname} on the same host, and redirects are not followed.`
}

export class HttpClient {
	private readonly baseUrl: string
	private readonly authHeader: () => string
	private readonly label: string
	private readonly redirectHint?: string

	constructor(options: HttpClientOptions) {
		this.baseUrl = options.baseUrl
		this.authHeader = options.authHeader
		this.label = options.label
		this.redirectHint = options.redirectHint
	}

	async request(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>,
		{ timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}
	): Promise<unknown> {
		// Everything down to the `try` sits outside it on purpose, and where the try starts is
		// the point rather than a detail of layout. The catch rewraps whatever it sees as an
		// HttpRequestError, and one of those carrying no status is how the retry policy
		// recognises a request that went out and got nothing back — which is worth sending
		// again. None of the preparation here is that, and several parts of it can throw:
		// `authHeader` on a missing credential or a token `btoa` rejects (anything outside
		// Latin-1, which is what a token pasted with a smart quote looks like),
		// `JSON.stringify` on a body it cannot serialize. Leaving them as plain errors is what
		// stops those being retried: the classifier finds no HttpRequestError in the chain and
		// gives up on the first attempt. Moved inside the try, each would instead be sent twice
		// more and fail identically both times, for three seconds of backoff and nothing else.
		const authorization = this.authHeader()

		// The endpoint goes out exactly as the calling method wrote it. Nothing here rewrites
		// it — a caller whose endpoint shape a model decides has to validate that value into
		// something known before it reaches this line.
		const url = new URL(`${this.baseUrl}${endpoint}`)

		if (params) {
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null) {
					url.searchParams.append(key, String(value))
				}
			})
		}

		const headers: Record<string, string> = {
			Authorization: authorization,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		}

		const body =
			method !== 'GET' && data !== null && data !== undefined ? JSON.stringify(data) : undefined

		// Create AbortController for timeout (compatible with all Workers versions).
		// `timeoutMs` is whatever the caller has left rather than a fresh 30 seconds, so a
		// retried attempt cannot extend the total past the deadline that governs the call.
		// Armed last, after everything above that can throw, so a failure while preparing the
		// request cannot leave a live timer behind holding the isolate awake.
		const abortController = new AbortController()
		const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

		const requestInit: RequestInit = {
			method,
			headers,
			// Redirects are not followed, because following one across origins silently
			// loses the credential above. `strip_authorization_on_cross_origin_redirect`
			// has been the platform default since 2025-09-01 and the compatibility date
			// now sits past it, so the follow-up request goes out unauthenticated and
			// the server answers 401 — indistinguishable from a revoked API token, with
			// nothing in the message pointing at a redirect. Confirmed against workerd
			// rather than inferred: a hop to another host arrives with no Authorization
			// header at all. Failing here instead says where the request was being sent.
			redirect: 'manual',
			signal: abortController.signal,
		}
		if (body !== undefined) {
			requestInit.body = body
		}

		try {
			const response = await fetch(url.toString(), requestInit)

			// A 3xx reaches this branch rather than being followed. It has to be caught
			// before the check below, which would otherwise report it as a bare status
			// with an empty body and say nothing about where the request was headed.
			if (response.status >= 300 && response.status < 400) {
				throw errorFromResponse(
					response,
					`${this.label} API Error: ${response.status} - ${describeRedirect(response, url, this.redirectHint)}`
				)
			}

			if (!response.ok) {
				// Reading the body is allowed to fail without taking the status down with it.
				// A body arrives as a stream, so `text()` can reject after the headers are in
				// hand — and letting that propagate would hand the outer catch a plain Error,
				// which it rewraps carrying no status. The classifier reads a statusless error
				// as a request that never got an answer, so a flatly refused 400 would be sent
				// twice more on the strength of a body we could not read. The status is the
				// part that decides, and it is already known here.
				let errorText: string
				try {
					errorText = await response.text()
				} catch {
					errorText = '<the body could not be read>'
				}

				throw errorFromResponse(
					response,
					`${this.label} API Error: ${response.status} - ${errorText}`
				)
			}

			// A success without a JSON content type has no body worth parsing. An empty DELETE
			// is the case that matters, since it answers with no content type at all.
			const contentType = response.headers.get('content-type')
			if (contentType && contentType.includes('application/json')) {
				try {
					return await response.json()
				} catch (cause) {
					// Carrying the status matters more than it looks. The server answered, so
					// this is not a request that failed to complete — and without a status
					// the retry policy would read it as exactly that and ask again, re-sending
					// something that already arrived on the strength of a body we could not
					// parse. 200 is not in the retryable set, so it fails once and says why.
					throw errorFromResponse(
						response,
						`${this.label} answered ${response.status} with a body that is not valid JSON`,
						cause
					)
				}
			} else {
				return { success: true }
			}
		} catch (error) {
			// Re-throw with more context, preserving original error chain for debugging.
			// What the response told us is carried onto the new error rather than left behind
			// in the message, so a caller holding what request threw can read it without
			// walking `cause`.
			if (error instanceof Error) {
				const answered = error instanceof HttpRequestError ? error : undefined
				throw new HttpRequestError(
					`${this.label} request failed: ${error.message}`,
					answered?.status,
					answered?.retryAfterMs,
					{ cause: error }
				)
			}
			throw error
		} finally {
			// One place rather than two. The timer used to be cleared on the line after `await
			// fetch` as well, which covered every path that got an answer but not the one where
			// fetch rejects outright — the path requestWithRetry walks up to three times a call.
			clearTimeout(timeoutId)
		}
	}

	/**
	 * Classification reads the status and nothing else, and never the message text. The
	 * message is built out of the response body, so matching on it cannot tell a 502 that
	 * happened from a 502 the body merely quotes.
	 *
	 * The rule asks two questions in order: did this come from `request` at all, and if so did
	 * the server answer it. An HttpRequestError means a request was actually sent, and a status
	 * on it means an answer came back.
	 *
	 * What no status means depends on the verb, and this is the sharp edge of the whole rule. It
	 * says the request went out and nothing came back — so for a read, where asking again costs
	 * only time, it is worth sending again whatever the underlying cause was. For a write it is
	 * the worst case there is rather than a mild one: not only might the work have happened, we
	 * never learned whether it did. That is strictly less knowledge than a 504 carries, and a
	 * 504 is already excluded below, so retrying this while refusing that would make no sense.
	 *
	 * Which is why `retryable` is chosen by the caller's verb and the statusless case is not
	 * shared. Reads keep the behaviour they have always had; a write retries the two refusals
	 * that cannot have acted, and nothing else.
	 *
	 * Written that way because the previous version matched specifics that do not exist on the
	 * runtime this deploys to. It looked for a `code` of ECONNRESET and friends, which is a
	 * Node convention — true of undici under Vitest, false of workerd. Probed against the real
	 * runtime before this was changed: an unreachable port gives a plain `Error` reading
	 * "Network connection lost." with no `code` at all, and a host that will not resolve gives
	 * "internal error; reference = <opaque id>". There is no name, code or wording worth keying
	 * on, and asking whether a response arrived makes the rule independent of all three.
	 */
	private isRetryableError(error: unknown, method: string): boolean {
		if (!(error instanceof Error)) {
			return false
		}

		const isWrite = method !== 'GET'

		for (const link of causeChain(error)) {
			if (link instanceof HttpRequestError) {
				// A status means the server answered. Retry only the ones that mean "ask again";
				// anything else it refused will be refused just as firmly on a second attempt.
				if (link.status !== undefined) {
					const retryable = isWrite ? RETRYABLE_STATUSES_FOR_WRITES : RETRYABLE_STATUSES
					return retryable.has(link.status)
				}

				// The request went out and nothing came back. A read asks again; a write cannot,
				// because this is the case where whether the work happened is unknowable.
				return !isWrite
			}
		}

		// Nothing in the chain came from `request`, so no request was ever made. A missing
		// credential or a malformed id fails here, and will fail identically next time.
		return false
	}

	/**
	 * One deadline governs the call. Attempts fit inside it rather than each starting a fresh
	 * timeout, because what a caller cares about is how long until it hears back, not how long
	 * any individual attempt was allowed to run. `MAX_ATTEMPTS` bounds the loop for failures
	 * that arrive instantly, and never binds once an attempt takes real time.
	 */
	async requestWithRetry(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>
	): Promise<unknown> {
		const deadline = Date.now() + TOTAL_TIMEOUT_MS
		let lastError: Error | undefined

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			try {
				return await this.request(method, endpoint, data, params, {
					timeoutMs: deadline - Date.now(),
				})
			} catch (error) {
				lastError = error as Error

				if (attempt === MAX_ATTEMPTS - 1 || !this.isRetryableError(error, method)) {
					throw error
				}

				// Exponential backoff — 1s, 2s, 4s, capped at 5s — spread across the lower half
				// of each step so that callers who failed together do not come back together.
				//
				// The spread matters because every GET retries, so requests that failed together
				// come back together. On a fixed ladder they all sleep exactly 1000ms and arrive
				// in one burst, which is the shape that turns a recovering backend into a
				// still-failing one.
				//
				// Do not size this against the fan-out of any one tool. What matters is that
				// separate callers hitting one struggling backend all wake on the same tick.
				//
				// Half the step rather than the whole of it, so the spread cannot undo the
				// backoff: the first retry lands somewhere in 500-1000ms, never at 20ms.
				const ladder = Math.min(1000 * Math.pow(2, attempt), 5000)
				const backoff = Math.round(ladder / 2 + Math.random() * (ladder / 2))

				// A rate limit says how long to wait, and asking again sooner is worse than not
				// asking at all: the early retry spends more of a quota already exhausted, and
				// providers commonly extend the penalty for a caller that keeps knocking. The
				// ladder is the fallback for the responses that say nothing.
				//
				// Which is why the spread is added after the requested wait rather than around
				// it. Jitter spreads a number this client chose, and `Retry-After` is not that —
				// spreading around it would have half the callers asking earlier than the server
				// agreed to. But a 429 window resets at one moment for everyone it refused, so
				// callers told the same figure all come back on the same tick, and a synchronised
				// burst arriving exactly at the reset is itself a way of keeping knocking. The
				// spread breaks that burst up without ever moving anyone earlier.
				const requested = retryAfterFrom(error)
				const delay =
					requested === undefined
						? backoff
						: requested + Math.round(Math.random() * RETRY_AFTER_SPREAD_MS)

				// Decide whether the next attempt fits before sleeping, rather than sleeping and
				// then discovering it does not. Waiting out a backoff only to send a request the
				// deadline aborts on arrival wastes the one thing the caller is short of.
				//
				// This is also the only cap on `Retry-After`, and the right one. Asked to wait
				// 60 seconds inside a 30 second budget, the honest answer is to stop and say so,
				// not to clamp the wait down to something the server did not agree to.
				if (Date.now() + delay + MINIMUM_ATTEMPT_MS > deadline) {
					console.warn(
						`Request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}) and the ${TOTAL_TIMEOUT_MS}ms deadline leaves no room to wait ${delay}ms and retry`,
						{
							error: error instanceof Error ? error.message : String(error),
							retryAfterMs: requested,
							method,
							endpoint,
						}
					)
					throw error
				}

				console.warn(
					`Request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`,
					{
						error: error instanceof Error ? error.message : String(error),
						method,
						endpoint,
					}
				)

				// Wait before retrying
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
		}

		throw lastError
	}

	/**
	 * What an API client's methods call. Reads the verb and picks the retry policy from it, so
	 * that an API method says what request it wants and never how many times to send it.
	 *
	 * Everything goes through `requestWithRetry`, and the verb decides what may be retried
	 * rather than whether anything is. Routing a write down a separate path was how the old
	 * blunter rule was expressed, and keeping it would have meant expressing the new one twice.
	 *
	 * A GET changes nothing, so sending it again costs only time — and since #32 the time is
	 * bounded anyway, because one deadline covers every attempt and every backoff together.
	 * That makes retrying a read close to free, and a read retries on everything in
	 * `RETRYABLE_STATUSES`, plus on getting no answer at all.
	 *
	 * A write is the case that has to be argued rather than assumed, and it retries only the
	 * two refusals that cannot have acted on it — see `RETRYABLE_STATUSES_FOR_WRITES`, which
	 * carries that argument. Everything else it does exactly once, including the case where no
	 * answer came back, because these endpoints take no idempotency key and a second attempt
	 * at a create that had already succeeded makes the second ticket.
	 *
	 * The dispatch existing at all is the point, and is what #54 was really about. Before it,
	 * each method chose between `request` and `requestWithRetry` for itself, and five had
	 * chosen to retry against fifty-odd that had not — `getTicket` surviving a 503 where
	 * `getMacro` gave up on it, though they are the same verb against the same API. They read
	 * as the methods that had caused visible trouble at some point and had retrying added to
	 * them one at a time. A policy nobody at the call site can express is what stops that
	 * reassembling; `which methods retry` in the wrapping client's tests is what catches a
	 * method going around this one to reach `request` directly.
	 */
	async send(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>
	): Promise<unknown> {
		return this.requestWithRetry(method, endpoint, data, params)
	}
}
