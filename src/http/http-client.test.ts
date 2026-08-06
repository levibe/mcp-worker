/**
 * The transport, driven through its own public surface — `request`, `requestWithRetry` and
 * the stubbed fetch beneath them. The options are Zendesk-shaped on purpose: the assertion
 * strings below are the exact messages the wrapping client produces, so they stayed
 * byte-identical when the transport moved out of it (#93), and they document what a consumer
 * gets for its `label` and `redirectHint`.
 *
 * What the Zendesk client adds on top — the credential closure, the subdomain, the id checks,
 * the verb dispatch reaching every API method — is covered in zendesk-client.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpClient, HttpRequestError } from './http-client'

/**
 * What the client actually hands fetch. Named separately from `RequestInit` so a test can
 * read a header or the body without casting; `vi.stubGlobal` takes the mock untyped, so
 * nothing has to line up with the real fetch signature.
 */
interface SentRequest {
	method: string
	headers: Record<string, string>
	body?: string
	redirect?: string
	signal: AbortSignal
}

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const failedResponse = (status: number, body: string) => new Response(body, { status })

/** Three seconds, in the numeric form Zendesk actually sends. */
const retryAfter = { 'retry-after': '3' }

/**
 * A response whose status arrives but whose body does not. The headers are in hand and the
 * stream then errors, which is how a connection dropped mid-body reaches the client.
 */
const unreadableResponse = (status: number) =>
	new Response(
		new ReadableStream({
			start(controller) {
				controller.error(new TypeError('body stream error'))
			},
		}),
		{ status }
	)

const redirectResponse = (status: number, location?: string) =>
	new Response(null, { status, headers: location ? { location } : {} })

/**
 * A Response body can only be read once, so `respond` is called per attempt rather than a
 * single Response being reused — a retry test would otherwise fail on a spent body.
 */
const stubFetch = (respond: (url: string, init: SentRequest) => Promise<Response>) => {
	const fetchMock = vi.fn(respond)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const urlOf = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => fetchMock.mock.calls[call][0]
const sent = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => fetchMock.mock.calls[call][1]

/**
 * A request that never answers, rejecting the way fetch does once its signal is aborted.
 *
 * Both Node and workerd reject with a DOMException rather than a renamed Error, and that it
 * is an Error at all is what lets causeChain walk to it, so the real type is pinned here.
 * The wording is workerd's, taken from a probe against the runtime rather than guessed —
 * note it has no trailing full stop, where Node's does.
 */
const stubUnanswered = () =>
	stubFetch(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted', 'AbortError'))
				})
			})
	)

/**
 * Advances past both backoff waits. They are ranges rather than fixed steps — [500, 1000]
 * after the first failure and [1000, 2000] after the second — so this has to clear the top of
 * both, and 3000 is that ceiling rather than the sum of two known waits.
 *
 * The extra 500 is deliberate slack. At exactly 3000 this works, but only because a wait that
 * lands on the boundary still fires; anyone widening the jitter or adding a fourth attempt
 * would then get `expected 3 calls, got 2` from whichever test ran, pointing at that test
 * rather than at the budget here that stopped covering it.
 */
const drainBackoff = () => vi.advanceTimersByTimeAsync(3500)

let http: HttpClient

beforeEach(() => {
	// Fake timers throughout: it keeps the 30s abort from ever firing on its own, and lets
	// the retry tests assert on the backoff instead of waiting three real seconds.
	vi.useFakeTimers()
	// Each retry warns before it waits.
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	http = new HttpClient({
		baseUrl: 'https://example.zendesk.com/api/v2',
		authHeader: () => `Basic ${btoa('agent@example.com/token:secret-token')}`,
		label: 'Zendesk',
		redirectHint: 'If the Zendesk subdomain has moved, update ZENDESK_SUBDOMAIN.',
	})
})

// The stubbed fetch and the console spy are undone by restoreMocks/unstubGlobals in
// vitest.config.ts; timers have no such switch, so they are put back by hand.
afterEach(() => {
	vi.useRealTimers()
})

/**
 * There used to be a sanitizer rewriting this path, and five tests here describing what it
 * rewrote. It is gone, so what is left to pin is the property that made it pointless: the path
 * a caller writes is the path that goes out, appended to the base URL exactly as written.
 *
 * One test rather than none, because reinstating a rewriting step would be invisible otherwise.
 * Every endpoint the wrapping client writes is already well formed, so a filter added back
 * would leave all of them untouched and nothing else in this file would notice.
 */
describe('the endpoint path', () => {
	it('is sent exactly as the caller wrote it', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		// A doubled slash, which no client method would ever write. It is here because the
		// old sanitizer would have collapsed it, so this is the assertion that fails if one
		// is put back — a well-formed path would survive a filter unchanged and prove nothing.
		await http.request('GET', '/tickets//42.json')

		expect(new URL(urlOf(fetchMock)).pathname).toBe('/api/v2/tickets//42.json')
	})
})

describe('request', () => {
	it('sends the Authorization header the authHeader option returns', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await http.request('GET', '/tickets.json')

		expect(sent(fetchMock).headers.Authorization).toBe(
			`Basic ${btoa('agent@example.com/token:secret-token')}`
		)
	})

	it('appends query parameters and drops the ones with no value', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await http.request('GET', '/tickets.json', null, {
			page: 2,
			sort_by: 'created_at',
			per_page: undefined,
			status: null,
		})

		const { searchParams } = new URL(urlOf(fetchMock))
		expect(searchParams.get('page')).toBe('2')
		expect(searchParams.get('sort_by')).toBe('created_at')
		expect(searchParams.has('per_page')).toBe(false)
		expect(searchParams.has('status')).toBe(false)
	})

	it('sends no body on a GET', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await http.request('GET', '/tickets.json', { subject: 'ignored' })

		expect(sent(fetchMock).body).toBeUndefined()
	})

	it('answers a response that is not JSON with a bare success', async () => {
		// 204 is what a delete answers with, and a 204 may not carry a body at all.
		stubFetch(async () => new Response(null, { status: 204 }))

		await expect(http.request('DELETE', '/tickets/42.json')).resolves.toEqual({ success: true })
	})

	it('turns a non-2xx into an error carrying the status and the body', async () => {
		stubFetch(async () => failedResponse(404, '{"error":"RecordNotFound"}'))

		await expect(http.request('GET', '/tickets/42.json')).rejects.toThrow(
			'Zendesk request failed: Zendesk API Error: 404 - {"error":"RecordNotFound"}'
		)
	})

	// The status is what the retry policy classifies on, so it has to survive the rewrap that
	// turns the failure into a sentence. Asserting it here is asserting the thing that makes
	// requestWithRetry able to tell a 429 from a body that quotes one.
	it('carries the status the server answered with', async () => {
		stubFetch(async () => failedResponse(429, 'Number of allowed API requests per minute'))

		const failure = http.request('GET', '/tickets.json')

		await expect(failure).rejects.toBeInstanceOf(HttpRequestError)
		await expect(failure).rejects.toHaveProperty('status', 429)
	})

	it('carries the status even when the body it answered with will not parse', async () => {
		stubFetch(
			async () =>
				new Response('<html>maintenance</html>', {
					headers: { 'content-type': 'application/json' },
				})
		)

		const failure = http.request('GET', '/tickets.json')

		await expect(failure).rejects.toThrow('Zendesk answered 200 with a body that is not valid JSON')
		await expect(failure).rejects.toHaveProperty('status', 200)
	})

	// Every branch that raises once a response is in hand goes through one helper built from that
	// response, so none of them can leave the status off — there is no argument to omit. The
	// point of the table is that it holds for a branch nobody had this invariant in mind while
	// writing, which is how all four of the instances in #56 got there.
	//
	// `Retry-After` comes along on all three, including the two whose status can never be
	// retried. That is the uniformity being asserted rather than a claim it is useful: reading
	// the header everywhere is what stops a site deciding it does not need one, which is exactly
	// how the JSON-parse branch came to omit it.
	it.each([
		['a refusal', 429, () => new Response('rate limited', { status: 429, headers: retryAfter })],
		['a redirect', 301, () => new Response(null, { status: 301, headers: retryAfter })],
		[
			'a body that will not parse',
			200,
			() =>
				new Response('<html>', {
					headers: { ...retryAfter, 'content-type': 'application/json' },
				}),
		],
	])(
		'carries the status and Retry-After of the response behind %s',
		async (_label, status, response) => {
			stubFetch(async () => response())

			const failure = http.request('GET', '/tickets.json')

			await expect(failure).rejects.toBeInstanceOf(HttpRequestError)
			await expect(failure).rejects.toHaveProperty('status', status)
			await expect(failure).rejects.toHaveProperty('retryAfterMs', 3_000)
		}
	)

	it('leaves the status unset when the request never got an answer', async () => {
		stubFetch(async () => {
			throw new TypeError('fetch failed')
		})

		const failure = http.request('GET', '/tickets.json')

		await expect(failure).rejects.toBeInstanceOf(HttpRequestError)
		await expect(failure).rejects.toHaveProperty('status', undefined)
	})

	// `request` rewraps every failure, so the server's error itself survives only as the cause.
	// Two things downstream read it back out, and asserting only on the message above would let
	// them drift apart from this unnoticed. `executeSearchWithStandardizedResponse` puts the
	// cause in the structured record it logs for Workers observability, and `isRetryableError`
	// walks the whole chain looking for the link that carries a status. Dropping the cause would
	// strip the real reason out of every failed search and leave the retry policy classifying a
	// refusal it can no longer see.
	it('keeps the underlying error as the cause of the one it throws', async () => {
		stubFetch(async () => failedResponse(404, '{"error":"RecordNotFound"}'))

		await expect(http.request('GET', '/tickets/42.json')).rejects.toHaveProperty(
			'cause.message',
			'Zendesk API Error: 404 - {"error":"RecordNotFound"}'
		)
	})
})

/**
 * Confirmed against workerd before any of this was written, rather than read off the flag's
 * documentation: under `follow`, a hop from 127.0.0.1 to localhost arrived carrying no
 * Authorization header at all, and under `manual` the 301 came back intact with `Location`
 * readable — not the opaque status-0 response a browser would hand back. The fix depends on
 * both of those, so they were worth establishing rather than assuming.
 */
describe('a redirect', () => {
	it('is not followed', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({ tickets: [] }))

		await http.request('GET', '/tickets.json')

		expect(sent(fetchMock).redirect).toBe('manual')
	})

	// The whole point of #39: this used to be a 401 carrying an authentication-error body,
	// which reads exactly like a revoked token and names nothing worth acting on. The last
	// sentence is the `redirectHint` option doing its job.
	it('to another host names that host and the secret to change', async () => {
		stubFetch(async () => redirectResponse(301, 'https://renamed.zendesk.com/api/v2/tickets.json'))

		await expect(http.request('GET', '/tickets.json')).rejects.toThrow(
			/redirected to renamed\.zendesk\.com\..*does not survive a hop to another host.*update ZENDESK_SUBDOMAIN/s
		)
	})

	it('to another host stops at the host when no redirectHint was given', async () => {
		const bare = new HttpClient({
			baseUrl: 'https://example.zendesk.com/api/v2',
			authHeader: () => 'Basic dGVzdA==',
			label: 'Zendesk',
		})
		stubFetch(async () => redirectResponse(301, 'https://renamed.zendesk.com/api/v2/tickets.json'))

		const failure = bare.request('GET', '/tickets.json')

		await expect(failure).rejects.toThrow('does not survive a hop to another host.')
		await expect(failure).rejects.not.toThrow('ZENDESK_SUBDOMAIN')
	})

	// A same-origin redirect would have kept the credential, so it is a different problem
	// with a different fix. Saying so keeps it from being read as the credential failure.
	it('to the same host says so instead', async () => {
		stubFetch(async () => redirectResponse(307, '/api/v2/tickets.json?page=2'))

		await expect(http.request('GET', '/tickets.json')).rejects.toThrow(
			'redirected to /api/v2/tickets.json on the same host'
		)
	})

	it('with no destination still fails rather than reporting an empty body', async () => {
		stubFetch(async () => redirectResponse(302))

		await expect(http.request('GET', '/tickets.json')).rejects.toThrow(
			'redirected without naming a destination'
		)
	})

	it('carries the status it answered with', async () => {
		stubFetch(async () => redirectResponse(301, 'https://renamed.zendesk.com/'))

		await expect(http.request('GET', '/tickets.json')).rejects.toHaveProperty('status', 301)
	})

	// It carries a status, so it is classified as an answer the server gave rather than as a
	// request that never completed. 3xx is not in the retryable set, so it is asked once.
	it('is not retried', async () => {
		const fetchMock = stubFetch(async () =>
			redirectResponse(301, 'https://renamed.zendesk.com/api/v2/tickets.json')
		)

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow('redirected to')

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe('the 30 second timeout', () => {
	it('aborts a request that has not answered', async () => {
		stubUnanswered()

		const attempt = http.request('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow(
			'Zendesk request failed: The operation was aborted'
		)

		await vi.advanceTimersByTimeAsync(29_999)
		await vi.advanceTimersByTimeAsync(1)
		await rejects
	})

	it('leaves no timer behind after a request succeeds', async () => {
		stubFetch(async () => jsonResponse({ tickets: [] }))

		await http.request('GET', '/tickets.json')

		expect(vi.getTimerCount()).toBe(0)
	})

	it('leaves no timer behind after the server answers with an error', async () => {
		stubFetch(async () => failedResponse(500, 'boom'))

		await expect(http.request('GET', '/tickets.json')).rejects.toThrow()

		expect(vi.getTimerCount()).toBe(0)
	})

	// The two above clear their timer on the line straight after `await fetch`, which is
	// reached whenever fetch answered at all. This is the one path that gets there through
	// the `finally` instead — fetch rejecting outright — and it is the path requestWithRetry
	// walks three times per call, so a leak here strands three live 30s timers in the isolate.
	it('leaves no timer behind when fetch itself rejects', async () => {
		stubFetch(async () => {
			throw new Error('fetch failed: ECONNRESET')
		})

		await expect(http.request('GET', '/tickets.json')).rejects.toThrow('ECONNRESET')

		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('requestWithRetry', () => {
	// 408 is here because it means the request timed out on the server's side. The old
	// classifier retried it only when the response body happened to contain the word
	// "timeout", so an empty-bodied 408 was dropped — this makes it the same answer either way.
	it.each([408, 429, 502, 503, 504])(
		'retries a %i and gives up after three attempts',
		async (status) => {
			const fetchMock = stubFetch(async () => failedResponse(status, 'transient'))

			const attempt = http.requestWithRetry('GET', '/tickets.json')
			const rejects = expect(attempt).rejects.toThrow(`Zendesk API Error: ${status}`)
			await drainBackoff()
			await rejects

			expect(fetchMock).toHaveBeenCalledTimes(3)
		}
	)

	/**
	 * The shapes a failed connection actually arrives in. They differ by runtime and share
	 * nothing worth matching on, which is the whole of #29.
	 *
	 * The first two are undici's, as Node and Vitest produce them — a bare "fetch failed" with
	 * the real socket error as its cause, carrying the `code` the old classifier looked for.
	 * The rest were probed against workerd, which is what actually serves production: an
	 * unreachable port is a plain `Error` reading "Network connection lost." with no `code` at
	 * all, and a host that will not resolve is an opaque reference id. None of the last three
	 * matched anything the old rule knew about, so all three went unretried where it counted.
	 *
	 * What they do share is that no response came back, and that is now what is asked.
	 */
	it.each([
		[
			'undici reporting a reset socket',
			() =>
				new TypeError('fetch failed', {
					cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
				}),
		],
		[
			'undici reporting a refused connection',
			() =>
				new TypeError('fetch failed', {
					cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
				}),
		],
		['workerd losing the connection', () => new Error('Network connection lost.')],
		[
			'workerd failing to resolve the host',
			() => new Error('internal error; reference = lfgpejlogahfrh23do9e5eib'),
		],
		// This one inverted with #29, and the inversion is the point. It used to assert a
		// single attempt, on the grounds that there was no code to go on — which describes
		// every dropped connection workerd will ever report.
		['a bare fetch failure with nothing beneath it', () => new TypeError('fetch failed')],
	])('retries %s', async (_label, makeError) => {
		const fetchMock = stubFetch(async () => {
			throw makeError()
		})

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk request failed')
		await drainBackoff()
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	// Preparing a request can fail, and none of those failures mean "nothing came back" —
	// they mean nothing was sent. `authHeader` throws before the try (the wrapping client's
	// credential checks live in it), and so does JSON.stringify on a body it cannot
	// serialize. Wrapped as HttpRequestErrors they would be indistinguishable from a dropped
	// connection and asked three times over; staying plain errors is the mechanism, so that
	// is what these assert, alongside fetch never being reached and no timer left behind.
	it('does not retry a throw from authHeader', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		const unconfigured = new HttpClient({
			baseUrl: 'https://example.zendesk.com/api/v2',
			authHeader: () => {
				throw new Error('Zendesk credentials not configured. Please set environment variables.')
			},
			label: 'Zendesk',
		})

		const failure = unconfigured.requestWithRetry('GET', '/tickets.json')

		await expect(failure).rejects.toThrow('Zendesk credentials not configured')
		await expect(failure).rejects.not.toBeInstanceOf(HttpRequestError)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('does not retry a body that will not serialize', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		const circular: Record<string, unknown> = {}
		circular.self = circular

		const failure = http.requestWithRetry('POST', '/tickets.json', circular)

		await expect(failure).rejects.toThrow(/circular/i)
		await expect(failure).rejects.not.toBeInstanceOf(HttpRequestError)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	// The server answered, so this is not a request that failed to complete. The status is put
	// on the error to say so — without it, the rule above would send the request a second time,
	// re-asking for something that already arrived because its body would not parse.
	it('does not retry a body that will not parse', async () => {
		const fetchMock = stubFetch(
			async () =>
				new Response('<html>maintenance</html>', {
					headers: { 'content-type': 'application/json' },
				})
		)

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk answered 200 with a body that is not valid JSON'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// The sibling of the case above, on the failure branch rather than the success one, and
	// the one that got missed. A body is a stream, so reading it can fail after the status is
	// already in hand. Letting that propagate would hand the outer catch a plain Error, which
	// it rewraps carrying no status — and the rule below reads a statusless error as a request
	// that never got an answer, so a flatly refused 400 would go out twice more. Asserting on
	// the count is the point; the message only shows the status survived to be reported.
	it('does not retry a 400 whose body cannot be read', async () => {
		const fetchMock = stubFetch(async () => unreadableResponse(400))

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 400'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// 500 is in here deliberately. It is a server error and it is not retried, because it is
	// used for faults that will fail the same way again — 502, 503 and 504 are the ones that
	// mean the request never reached a healthy backend.
	it.each([400, 401, 403, 404, 422, 500])('does not retry a %i', async (status) => {
		const fetchMock = stubFetch(async () => failedResponse(status, 'refused'))

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			`Zendesk API Error: ${status}`
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// This was #18. The classifier used to search the error message, which `request` builds
	// out of the response body, so three digits quoted in that body were indistinguishable
	// from the status itself. It reads `status` now, so the body can say whatever it likes.
	it('does not retry a 400 whose body happens to mention 502', async () => {
		const fetchMock = stubFetch(async () =>
			failedResponse(400, '{"description":"upstream returned 502 earlier"}')
		)

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 400'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// This was #17, and it inverted with #32. It used to advance step by step through three
	// 30s attempts and two backoffs, roughly 93 seconds, precisely so the cost was visible.
	// The deadline covers the whole call now, so a hung endpoint spends it on the first
	// attempt and there is nothing left to retry into — 30 seconds, as it was before #24 made
	// retrying a timeout possible. The AbortError is still two links down the chain, which is
	// why the classifier walks `cause` rather than reading only what it was handed.
	it('does not retry a hung request, because one attempt spends the whole deadline', async () => {
		const fetchMock = stubUnanswered()

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('The operation was aborted')

		await vi.advanceTimersByTimeAsync(30_000)
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	// The second attempt inherits what is left rather than starting its own 30 seconds, so
	// the whole call still lands on the deadline instead of at 61 seconds.
	it('gives a later attempt only the time the deadline has left', async () => {
		// Pinned to the top of the jitter so the backoff is exactly the second the arithmetic
		// below talks about. The assertions hold at any point in the range — the deadline is an
		// absolute instant, so a shorter backoff just means a longer second attempt — but the
		// comments would stop describing what ran.
		vi.spyOn(Math, 'random').mockReturnValue(1)
		let calls = 0
		const fetchMock = stubFetch((_url, init) => {
			calls += 1
			if (calls === 1) return Promise.resolve(failedResponse(503, 'unavailable'))
			return new Promise<Response>((_resolve, reject) => {
				init.signal.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted', 'AbortError'))
				})
			})
		})

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('The operation was aborted')

		await vi.advanceTimersByTimeAsync(1_000) // backoff, then the second attempt starts
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// 29s more reaches the deadline, not 30 — the second attempt started a second late.
		await vi.advanceTimersByTimeAsync(28_999)
		await vi.advanceTimersByTimeAsync(1)
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(vi.getTimerCount()).toBe(0)
	})

	// The decision is taken before the sleep rather than after it. Waiting out a backoff only
	// to send a request that gets aborted on arrival spends the one thing the caller is short
	// of, and reports the failure a second later than it was already known.
	it('stops instead of sleeping into a retry the deadline cannot fit', async () => {
		const fetchMock = stubFetch(
			() =>
				new Promise<Response>((resolve) =>
					setTimeout(() => resolve(failedResponse(503, 'unavailable')), 29_000)
				)
		)

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 503')

		await vi.advanceTimersByTimeAsync(29_000)
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	/**
	 * The ladder is jittered across the lower half of each step, so it is a range rather than a
	 * pair of numbers and these two tests take its ends. Pinning `Math.random` is what makes
	 * either end assertable; the alternative is a test that accepts a window, which would pass
	 * just as happily if the spread quietly widened to something that undid the backoff.
	 */
	it('waits at most one second, then at most two, and never sleeps after the last attempt', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 503')

		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(1999)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		await rejects
		expect(vi.getTimerCount()).toBe(0)
	})

	/**
	 * The floor, which is the half of the spread worth pinning hardest. Jitter that can reach
	 * zero is not a spread but a retry storm with extra steps, so the first wait has to stay
	 * half a second even when the roll comes up as low as it goes.
	 */
	it('waits at least half of each step when the jitter rolls low', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 503')

		await vi.advanceTimersByTimeAsync(499)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		await rejects
		expect(vi.getTimerCount()).toBe(0)
	})

	/**
	 * What the jitter is actually for, which neither end of the range shows on its own: two
	 * callers that failed at the same instant have to come back at different ones. This is the
	 * fan-out case in miniature — a hierarchy walk issues a read per category and then one per
	 * section through nested Promise.all, so a 503 fails all of them together, and on a fixed
	 * ladder all of them would return together too.
	 */
	it('does not send two callers that failed together back together', async () => {
		const rolls = [0, 1]
		vi.spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0)
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const first = http.requestWithRetry('GET', '/tickets.json')
		const second = http.requestWithRetry('GET', '/macros.json')
		const settled = Promise.allSettled([first, second])

		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// The one that rolled low is back at 500ms; the one that rolled high waits out the
		// full second. Same failure, same instant, different return.
		await vi.advanceTimersByTimeAsync(500)
		expect(fetchMock).toHaveBeenCalledTimes(3)
		await vi.advanceTimersByTimeAsync(500)
		expect(fetchMock).toHaveBeenCalledTimes(4)

		await drainBackoff()
		await settled
	})

	it('stops as soon as an attempt succeeds', async () => {
		let calls = 0
		const fetchMock = stubFetch(async () => {
			calls += 1
			return calls === 1 ? failedResponse(503, 'unavailable') : jsonResponse({ tickets: [] })
		})

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		await drainBackoff()

		await expect(attempt).resolves.toEqual({ tickets: [] })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

describe('Retry-After', () => {
	const rateLimited = (retryAfter: string) =>
		new Response('Number of allowed API requests per minute exceeded', {
			status: 429,
			headers: { 'retry-after': retryAfter },
		})

	it('is carried on the error, next to the status', async () => {
		stubFetch(async () => rateLimited('30'))

		await expect(http.request('GET', '/tickets.json')).rejects.toHaveProperty(
			'retryAfterMs',
			30_000
		)
	})

	// The ladder would have asked again within a second. Retrying sooner than you were told to
	// is worse than not retrying: it spends more of a quota already exhausted, and providers
	// commonly extend the penalty for a caller that keeps knocking. The spread on top answers
	// the other way of keeping knocking: the header speaks in whole seconds, so every caller
	// refused together is told the same figure, and without the spread they would all arrive
	// back in one burst at the reset moment. Pinned at the top of the spread here; the floor
	// is the test below.
	it('waits out the requested figure plus a spread instead of running its own ladder', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => rateLimited('2'))

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(2_999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(3_000)
		await rejects
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	// The floor of the spread window, which is the half worth pinning hardest: at its lowest
	// roll the wait is exactly the figure the server named. The spread only ever adds — a roll
	// that could land the retry before the reset would be asking earlier than agreed, which
	// is the thing this path exists to avoid.
	it('never retries before the moment the server named', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const fetchMock = stubFetch(async () => rateLimited('2'))

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(1_999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(2_000)
		await rejects
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	// The deadline from #32 is the only cap on this, and the right one. Clamping a 60 second
	// wait down to something the server never agreed to would defeat the point of reading the
	// header, so the honest answer to a wait that will not fit the budget is to stop.
	it('ends the call when the wait it asks for exceeds the deadline', async () => {
		const fetchMock = stubFetch(async () => rateLimited('60'))

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 429'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	// The spread counts against the deadline the same way the wait it rides on does, because
	// the fit check reads the delay with the spread already in it. Twenty-nine seconds fits
	// the budget on its own; with the spread at its widest it does not, and the honest answer
	// stays the one above — stop and say so rather than sleep into a retry that cannot run.
	it('counts the spread against the deadline when deciding whether a retry fits', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => rateLimited('29'))

		await expect(http.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 429'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	// Zendesk sends seconds, but the header is defined as seconds or an HTTP date, and
	// reading only half of it without saying so is the kind of gap that gets found in
	// production rather than here.
	it('understands the date form as well as the seconds form', async () => {
		vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
		// The spread is pinned to its floor because this test is about reading the header
		// form, and the arithmetic below should be the date's four seconds and nothing else.
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const fetchMock = stubFetch(async () => rateLimited('Sat, 01 Aug 2026 12:00:04 GMT'))

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(3_999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await drainBackoff()
		await rejects
	})

	/**
	 * None of these says anything usable about how long to wait, so the ladder answers instead.
	 * `Math.random` is pinned to the top of the jitter so that "the ladder answered" is a single
	 * number to assert rather than a window — what these are about is which of the two sources
	 * decided, not what the spread does with it.
	 *
	 * The last three are why the guard is a positive-wait check rather than a tighter pattern.
	 * `Date.parse` reads '-5' as May 2001 and '120' as the year 120, so it cannot be trusted
	 * to reject nonsense on its own — and a header that resolves into the past would otherwise
	 * mean "retry now", which against an exhausted quota is the one answer worth avoiding.
	 */
	it.each([
		['a word', 'soon'],
		['an empty header', ''],
		['exponential notation', '1e3'],
		['zero seconds', '0'],
		['a negative number', '-5'],
		['a date already past', 'Sat, 01 Aug 2026 11:59:00 GMT'],
	])('falls back to the ladder for %s', async (_label, header) => {
		vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => rateLimited(header))

		const attempt = http.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await drainBackoff()
		await rejects
	})
})
