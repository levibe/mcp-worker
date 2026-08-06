// workers-oauth-utils.ts

import type { ClientInfo } from '@cloudflare/workers-oauth-provider' // Adjust path if necessary

// Local edits to this vendored file, to keep if it is ever refreshed from upstream: every
// base64 round-trip goes through the UTF-8 helpers, because bare btoa throws on any code point
// above U+00FF and these payloads carry callers' own text; and the module is typed by narrowing
// from `unknown` rather than upstream's `any`s, so it holds the same `no-explicit-any: error`
// as the rest of the package.
import { decodeBase64Json, decodeBase64Utf8, encodeBase64Json, encodeBase64Utf8 } from './base64'
import { isRecord } from './narrow'

const COOKIE_NAME = 'mcp-approved-clients'
const ONE_YEAR_IN_SECONDS = 31536000

// --- Helper Functions ---

/**
 * Encodes arbitrary data to a URL-safe base64 string.
 * @param data - The data to encode (will be stringified).
 * @returns A URL-safe base64 encoded string.
 */
function _encodeState(data: unknown): string {
	try {
		return encodeBase64Json(data)
	} catch (e) {
		console.error('Error encoding state:', e)
		throw new Error('Could not encode state')
	}
}

/**
 * Decodes a URL-safe base64 string back to its original data.
 * @param encoded - The URL-safe base64 encoded string.
 * @returns The original data, `unknown` because the JSON said whatever it said — the caller
 * narrows.
 */
function decodeState(encoded: string): unknown {
	try {
		return decodeBase64Json(encoded)
	} catch (e) {
		console.error('Error decoding state:', e)
		throw new Error('Could not decode state')
	}
}

/**
 * Imports a secret key string for HMAC-SHA256 signing.
 * @param secret - The raw secret key string.
 * @returns A promise resolving to the CryptoKey object.
 */
async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error('COOKIE_SECRET is not defined. A secret key is required for signing cookies.')
	}
	const enc = new TextEncoder()
	return crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ hash: 'SHA-256', name: 'HMAC' },
		false, // not extractable
		['sign', 'verify'] // key usages
	)
}

/**
 * Signs data using HMAC-SHA256.
 * @param key - The CryptoKey for signing.
 * @param data - The string data to sign.
 * @returns A promise resolving to the signature as a hex string.
 */
async function signData(key: CryptoKey, data: string): Promise<string> {
	const enc = new TextEncoder()
	const signatureBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(data))
	// Convert ArrayBuffer to hex string
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

/**
 * Verifies an HMAC-SHA256 signature.
 * @param key - The CryptoKey for verification.
 * @param signatureHex - The signature to verify (hex string).
 * @param data - The original data that was signed.
 * @returns A promise resolving to true if the signature is valid, false otherwise.
 */
async function verifySignature(
	key: CryptoKey,
	signatureHex: string,
	data: string
): Promise<boolean> {
	const enc = new TextEncoder()
	try {
		// Convert hex signature back to ArrayBuffer
		const signatureBytes = new Uint8Array(
			signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16))
		)
		return await crypto.subtle.verify('HMAC', key, signatureBytes.buffer, enc.encode(data))
	} catch (e) {
		// Handle errors during hex parsing or verification
		console.error('Error verifying signature:', e)
		return false
	}
}

/**
 * Parses the signed cookie and verifies its integrity.
 * @param cookieHeader - The value of the Cookie header from the request.
 * @param secret - The secret key used for signing.
 * @returns A promise resolving to the list of approved client IDs if the cookie is valid, otherwise null.
 */
async function getApprovedClientsFromCookie(
	cookieHeader: string | null,
	secret: string
): Promise<string[] | null> {
	if (!cookieHeader) return null

	const cookies = cookieHeader.split(';').map((c) => c.trim())
	const targetCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))

	if (!targetCookie) return null

	const cookieValue = targetCookie.substring(COOKIE_NAME.length + 1)
	const parts = cookieValue.split('.')

	if (parts.length !== 2) {
		console.warn('Invalid cookie format received.')
		return null // Invalid format
	}

	const [signatureHex, base64Payload] = parts

	// The `atob` inside the decode throws on any character outside the base64 alphabet, and the
	// cookie only has to look structurally right — two dot-separated parts — to reach here. Left
	// unhandled that throw escapes to Hono as a 500, and since the cookie is written with a
	// one-year Max-Age the user then gets that 500 on every subsequent /authorize until they
	// clear cookies by hand. Returning null instead falls through to the approval dialog, which
	// is what every other malformed-cookie case below already does.
	//
	// The signature below is computed over this decoded string, and the decode gives back the
	// exact string the writer signed for both formats — the UTF-8 one this file writes now, and
	// the bare-btoa one still sitting in browsers under that Max-Age — so verification is
	// unaffected by which encoder wrote the cookie.
	//
	// This is deliberately its own try rather than an extension of the one further down. That
	// one starts after `importKey`, which throws when COOKIE_ENCRYPTION_KEY is missing — a
	// deployment being misconfigured, not a cookie being bad. Widening a single try over both
	// would silently answer a missing secret with the approval dialog forever.
	let payload: string
	try {
		payload = decodeBase64Utf8(base64Payload)
	} catch {
		console.warn('Cookie payload is not valid base64.')
		return null
	}

	const key = await importKey(secret)
	const isValid = await verifySignature(key, signatureHex, payload)

	if (!isValid) {
		console.warn('Cookie signature verification failed.')
		return null // Signature invalid
	}

	try {
		const approvedClients: unknown = JSON.parse(payload)
		if (!Array.isArray(approvedClients)) {
			console.warn('Cookie payload is not an array.')
			return null // Payload isn't an array
		}
		// Ensure all elements are strings
		if (!approvedClients.every((item): item is string => typeof item === 'string')) {
			console.warn('Cookie payload contains non-string elements.')
			return null
		}
		return approvedClients
	} catch (e) {
		console.error('Error parsing cookie payload:', e)
		return null // JSON parsing failed
	}
}

// --- Exported Functions ---

/**
 * Checks if a given client ID has already been approved by the user,
 * based on a signed cookie.
 *
 * @param request - The incoming Request object to read cookies from.
 * @param clientId - The OAuth client ID to check approval for.
 * @param cookieSecret - The secret key used to sign/verify the approval cookie.
 * @returns A promise resolving to true if the client ID is in the list of approved clients in a valid cookie, false otherwise.
 */
export async function clientIdAlreadyApproved(
	request: Request,
	clientId: string,
	cookieSecret: string
): Promise<boolean> {
	if (!clientId) return false
	const cookieHeader = request.headers.get('Cookie')
	const approvedClients = await getApprovedClientsFromCookie(cookieHeader, cookieSecret)

	return approvedClients?.includes(clientId) ?? false
}

/**
 * Configuration for the approval dialog
 */
export interface ApprovalDialogOptions {
	/**
	 * Client information to display in the approval dialog
	 */
	client: ClientInfo | null
	/**
	 * Server information to display in the approval dialog
	 */
	server: {
		name: string
		logo?: string
		description?: string
	}
	/**
	 * Arbitrary state data to pass through the approval flow
	 * Will be encoded in the form and returned when approval is complete
	 *
	 * `object` rather than `Record<string, unknown>` because the value only ever reaches
	 * `encodeBase64Json`, so "some object" is the entire real constraint — and interfaces
	 * carry no implicit index signature, so the `Record` type would refuse interface-typed
	 * values the `any`-typed field always accepted.
	 */
	state: object
}

/**
 * Renders an approval dialog for OAuth authorization
 * The dialog displays information about the client and server
 * and includes a form to submit approval
 *
 * @param request - The HTTP request
 * @param options - Configuration for the approval dialog
 * @returns A Response containing the HTML approval dialog
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
	const { client, server, state } = options

	// Encode state for form submission
	const encodedState = encodeBase64Json(state)

	// Sanitize any untrusted content
	const serverName = sanitizeHtml(server.name)
	const clientName = client?.clientName ? sanitizeHtml(client.clientName) : 'Unknown MCP Client'
	const serverDescription = server.description ? sanitizeHtml(server.description) : ''

	// These four are the only client-supplied values that end up inside an `href` or `src`, so
	// they need the scheme checked as well as the HTML escaped. An empty result is what the
	// blocks below already treat as "no link", so a rejected URL renders as nothing at all.
	const logoUrl = server.logo ? sanitizeUrl(server.logo) : ''
	const clientUri = client?.clientUri ? sanitizeUrl(client.clientUri) : ''
	const policyUri = client?.policyUri ? sanitizeUrl(client.policyUri) : ''
	const tosUri = client?.tosUri ? sanitizeUrl(client.tosUri) : ''

	// Client contacts
	const contacts =
		client?.contacts && client.contacts.length > 0 ? sanitizeHtml(client.contacts.join(', ')) : ''

	// Get redirect URIs
	const redirectUris =
		client?.redirectUris && client.redirectUris.length > 0
			? client.redirectUris.map((uri) => sanitizeHtml(uri))
			: []

	// Generate HTML for the approval dialog
	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          /* Modern, responsive styling with system fonts */
          :root {
            --primary-color: #0070f3;
            --error-color: #f44336;
            --border-color: #e5e7eb;
            --text-color: #333;
            --background-color: #fff;
            --card-shadow: 0 8px 36px 8px rgba(0, 0, 0, 0.1);
          }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, 
                         Helvetica, Arial, sans-serif, "Apple Color Emoji", 
                         "Segoe UI Emoji", "Segoe UI Symbol";
            line-height: 1.6;
            color: var(--text-color);
            background-color: #f9fafb;
            margin: 0;
            padding: 0;
          }
          
          .container {
            max-width: 600px;
            margin: 2rem auto;
            padding: 1rem;
          }
          
          .precard {
            padding: 2rem;
            text-align: center;
          }
          
          .card {
            background-color: var(--background-color);
            border-radius: 8px;
            box-shadow: var(--card-shadow);
            padding: 2rem;
          }
          
          .header {
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 1.5rem;
          }
          
          .logo {
            width: 48px;
            height: 48px;
            margin-right: 1rem;
            border-radius: 8px;
            object-fit: contain;
          }
          
          .title {
            margin: 0;
            font-size: 1.3rem;
            font-weight: 400;
          }
          
          .alert {
            margin: 0;
            font-size: 1.5rem;
            font-weight: 400;
            margin: 1rem 0;
            text-align: center;
          }
          
          .description {
            color: #555;
          }
          
          .client-info {
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 1rem 1rem 0.5rem;
            margin-bottom: 1.5rem;
          }
          
          .client-name {
            font-weight: 600;
            font-size: 1.2rem;
            margin: 0 0 0.5rem 0;
          }
          
          .client-detail {
            display: flex;
            margin-bottom: 0.5rem;
            align-items: baseline;
          }
          
          .detail-label {
            font-weight: 500;
            min-width: 120px;
          }
          
          .detail-value {
            font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            word-break: break-all;
          }
          
          .detail-value a {
            color: inherit;
            text-decoration: underline;
          }
          
          .detail-value.small {
            font-size: 0.8em;
          }
          
          .external-link-icon {
            font-size: 0.75em;
            margin-left: 0.25rem;
            vertical-align: super;
          }
          
          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 1rem;
            margin-top: 2rem;
          }
          
          .button {
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-size: 1rem;
          }
          
          .button-primary {
            background-color: var(--primary-color);
            color: white;
          }
          
          .button-secondary {
            background-color: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-color);
          }
          
          /* Responsive adjustments */
          @media (max-width: 640px) {
            .container {
              margin: 1rem auto;
              padding: 0.5rem;
            }
            
            .card {
              padding: 1.5rem;
            }
            
            .client-detail {
              flex-direction: column;
            }
            
            .detail-label {
              min-width: unset;
              margin-bottom: 0.25rem;
            }
            
            .actions {
              flex-direction: column;
            }
            
            .button {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="precard">
            <div class="header">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ''}
            <h1 class="title"><strong>${serverName}</strong></h1>
            </div>
            
            ${serverDescription ? `<p class="description">${serverDescription}</p>` : ''}
          </div>
            
          <div class="card">
            
            <h2 class="alert"><strong>${clientName || 'A new MCP Client'}</strong> is requesting access</h1>
            
            <div class="client-info">
              <div class="client-detail">
                <div class="detail-label">Name:</div>
                <div class="detail-value">
                  ${clientName}
                </div>
              </div>
              
              ${
								clientUri
									? `
                <div class="client-detail">
                  <div class="detail-label">Website:</div>
                  <div class="detail-value small">
                    <a href="${clientUri}" target="_blank" rel="noopener noreferrer">
                      ${clientUri}
                    </a>
                  </div>
                </div>
              `
									: ''
							}
              
              ${
								policyUri
									? `
                <div class="client-detail">
                  <div class="detail-label">Privacy Policy:</div>
                  <div class="detail-value">
                    <a href="${policyUri}" target="_blank" rel="noopener noreferrer">
                      ${policyUri}
                    </a>
                  </div>
                </div>
              `
									: ''
							}
              
              ${
								tosUri
									? `
                <div class="client-detail">
                  <div class="detail-label">Terms of Service:</div>
                  <div class="detail-value">
                    <a href="${tosUri}" target="_blank" rel="noopener noreferrer">
                      ${tosUri}
                    </a>
                  </div>
                </div>
              `
									: ''
							}
              
              ${
								redirectUris.length > 0
									? `
                <div class="client-detail">
                  <div class="detail-label">Redirect URIs:</div>
                  <div class="detail-value small">
                    ${redirectUris.map((uri) => `<div>${uri}</div>`).join('')}
                  </div>
                </div>
              `
									: ''
							}
              
              ${
								contacts
									? `
                <div class="client-detail">
                  <div class="detail-label">Contact:</div>
                  <div class="detail-value">${contacts}</div>
                </div>
              `
									: ''
							}
            </div>
            
            <p>This MCP Client is requesting to be authorized on ${serverName}. If you approve, you will be redirected to complete authentication.</p>
            
            <form method="post" action="${new URL(request.url).pathname}">
              <input type="hidden" name="state" value="${encodedState}">
              
              <div class="actions">
                <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-primary">Approve</button>
              </div>
            </form>
          </div>
        </div>
      </body>
    </html>
  `

	return new Response(htmlContent, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
		},
	})
}

/**
 * Result of parsing the approval form submission.
 */
export interface ParsedApprovalResult {
	/**
	 * The original state object passed through the form — the whole record, so whatever a
	 * caller put beside `oauthReqInfo` on the way in is readable on the way back. It arrived
	 * through a form body, and the parse checked `oauthReqInfo.clientId` and nothing else —
	 * hence every value `unknown`: the rest is still the submitter's claim, and the caller
	 * narrows or casts with that said, the way `/callback` does for its own state.
	 */
	state: Record<string, unknown> & { oauthReqInfo?: unknown }
	/** Headers to set on the redirect response, including the Set-Cookie header. */
	headers: Record<string, string>
}

/**
 * Parses the form submission from the approval dialog, extracts the state,
 * and generates Set-Cookie headers to mark the client as approved.
 *
 * @param request - The incoming POST Request object containing the form data.
 * @param cookieSecret - The secret key used to sign the approval cookie.
 * @returns A promise resolving to an object containing the parsed state and necessary headers.
 * @throws If the request method is not POST, form data is invalid, or state is missing.
 */
export async function parseRedirectApproval(
	request: Request,
	cookieSecret: string
): Promise<ParsedApprovalResult> {
	if (request.method !== 'POST') {
		throw new Error('Invalid request method. Expected POST.')
	}

	let state: Record<string, unknown> & { oauthReqInfo?: unknown }
	let clientId: string

	try {
		const formData = await request.formData()
		const encodedState = formData.get('state')

		if (typeof encodedState !== 'string' || !encodedState) {
			throw new Error("Missing or invalid 'state' in form data.")
		}

		const decoded = decodeState(encodedState)

		// Narrowed the way /callback narrows its own state, and to a string deliberately: this
		// clientId joins the approval list, and getApprovedClientsFromCookie refuses any list
		// holding a non-string — so a state whose clientId were some other truthy JSON value
		// would mint a cookie its own reader discards, taking every prior approval with it.
		if (
			!isRecord(decoded) ||
			!isRecord(decoded.oauthReqInfo) ||
			typeof decoded.oauthReqInfo.clientId !== 'string' ||
			!decoded.oauthReqInfo.clientId
		) {
			throw new Error('Could not extract clientId from state object.')
		}

		state = decoded
		clientId = decoded.oauthReqInfo.clientId
	} catch (e) {
		console.error('Error processing form submission:', e)
		// Rethrow or handle as appropriate, maybe return a specific error response
		throw new Error(`Failed to parse approval form: ${e instanceof Error ? e.message : String(e)}`)
	}

	// Get existing approved clients
	const cookieHeader = request.headers.get('Cookie')
	const existingApprovedClients =
		(await getApprovedClientsFromCookie(cookieHeader, cookieSecret)) || []

	// Add the newly approved client ID (avoid duplicates)
	const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, clientId]))

	// Sign the updated list
	const payload = JSON.stringify(updatedApprovedClients)
	const key = await importKey(cookieSecret)
	const signature = await signData(key, payload)
	const newCookieValue = `${signature}.${encodeBase64Utf8(payload)}` // signature.base64(payload)

	// Generate Set-Cookie header
	const headers: Record<string, string> = {
		'Set-Cookie': `${COOKIE_NAME}=${newCookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_IN_SECONDS}`,
	}

	return { headers, state }
}

/**
 * Sanitizes HTML content to prevent XSS attacks
 * @param unsafe - The unsafe string that might contain HTML
 * @returns A safe string with HTML special characters escaped
 */
function sanitizeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;')
}

/**
 * Sanitizes a URL destined for an `href` or `src` attribute, returning '' if it is not an
 * absolute http: or https: URL.
 *
 * Escaping alone is not enough here, which is the whole reason this exists. `sanitizeHtml`
 * stops a value breaking out of the attribute it sits in, but a dangerous scheme needs none
 * of the characters it escapes — `javascript:alert(document.cookie)` passes through it
 * completely untouched, and clicking the resulting link runs script on this worker's own
 * origin, which is also where the approval cookie lives.
 *
 * The check belongs here at the render boundary rather than only at registration.
 * `@cloudflare/workers-oauth-provider` validates these fields when a client registers, but
 * `/register` is public and ran for a long time under 0.0.5, which checked only that they
 * were strings. Records written then sit in KV with no TTL and are read back by `getClient`
 * unvalidated, so anything already planted keeps working indefinitely. Validating on the way
 * out holds regardless of what any given library version accepted on the way in.
 *
 * The parsed `href` is returned rather than the original input, so what renders is the
 * canonical, percent-encoded form of what a browser would resolve. It still goes through
 * `sanitizeHtml`, because URL parsing leaves characters like `'` alone in a path and those
 * would otherwise break out of the attribute.
 */
function sanitizeUrl(unsafe: string): string {
	let url: URL
	try {
		url = new URL(unsafe)
	} catch {
		return ''
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''

	return sanitizeHtml(url.href)
}
