/**
 * Base64 for values that ride through a URL or a cookie, safe for any Unicode rather than
 * only the code points `btoa` accepts.
 *
 * `btoa` maps code units to bytes one for one, so it throws on anything above U+00FF — and
 * the strings that reach these helpers carry callers' own text: OAuth `state` is opaque
 * client data, and nothing upstream constrains it to ASCII. Going through UTF-8 first means
 * there is no character a caller can send that fails to round-trip.
 */

/**
 * Encodes text as base64 of its UTF-8 bytes.
 *
 * The spread is sized to what these helpers carry — an authorization request, an approval
 * list, hundreds of bytes. `String.fromCharCode` takes its arguments on the stack, so this
 * is the simple way to encode something small, not the way to encode something large.
 */
export const encodeBase64Utf8 = (text: string): string => {
	const bytes = new TextEncoder().encode(text)
	return btoa(String.fromCharCode(...bytes))
}

/**
 * Decodes base64 back to text, reading the bytes as UTF-8 and falling back to the raw code
 * units when they are not.
 *
 * The fallback is what keeps payloads written by the old bare-`btoa` encoder readable, and
 * it is permanent rather than transitional: the approval cookie is written with a one-year
 * Max-Age, so old-format payloads keep arriving from browsers long after the deploy that
 * retired the encoder that wrote them. The two formats agree on ASCII, and the old encoder
 * could only write Latin-1 — which invalid UTF-8 identifies exactly, since nothing the new
 * encoder writes can fail the fatal decode.
 *
 * Deterministic in the direction that matters, not in both. Bytes that fail UTF-8 can only
 * be the old format; old-format bytes that happen to form valid UTF-8 read as the new format
 * instead, and a test pins that as accepted rather than intended.
 */
export const decodeBase64Utf8 = (encoded: string): string => {
	const binary = atob(encoded)
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
	try {
		// `ignoreBOM: false` is the platform default, stated because the Workers types make
		// both options required rather than because it is a choice.
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
	} catch {
		return binary
	}
}

/** Encodes a value as base64 of its JSON, through UTF-8. */
export const encodeBase64Json = (value: unknown): string => encodeBase64Utf8(JSON.stringify(value))

/**
 * Decodes base64 JSON, reading old-format payloads through the fallback above.
 *
 * Returns `unknown` for the reason the Zendesk client does: the JSON said whatever it said,
 * and the caller narrows.
 */
export const decodeBase64Json = (encoded: string): unknown => JSON.parse(decodeBase64Utf8(encoded))
