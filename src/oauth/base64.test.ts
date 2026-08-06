/**
 * The encode side is one expression and hard to get wrong; the decode side decides — try the
 * bytes as UTF-8, fall back to raw code units — so the fallback and its limits are what these
 * tests mostly pin. The legacy cases matter as much as the round-trips: the approval cookie's
 * one-year Max-Age means bare-btoa payloads keep arriving long after the encoder that wrote
 * them is gone, so the fallback is load-bearing forever, not scaffolding for a migration.
 */

import { describe, expect, it } from 'vitest'
import { decodeBase64Json, decodeBase64Utf8, encodeBase64Json, encodeBase64Utf8 } from './base64'

describe('round-trips', () => {
	// One value per range that behaves differently under btoa: ASCII survives it, Latin-1
	// survives it as single bytes, U+0100 is the first code point it throws on, and an emoji
	// is two code units, so it proves surrogate pairs re-pair.
	it.each([
		['ASCII', 'plain ascii text'],
		['Latin-1', 'café'],
		['the first code point bare btoa refuses', 'Ā'],
		['an astral character', 'a 😀 in the middle'],
		['all of them at once', 'ascii é Ā 😀'],
	])('round-trips %s through the string pair', (_label, text) => {
		expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text)
	})

	it.each([
		['ASCII', { clientId: 'test-client', scope: ['profile'] }],
		['non-ASCII in a value', { clientId: 'test-client', state: 'Āé😀' }],
		['non-ASCII in a key', { clé: 'value' }],
		['a bare string', 'Ā'],
		['null', null],
	])('round-trips %s through the JSON pair', (_label, value) => {
		expect(decodeBase64Json(encodeBase64Json(value))).toEqual(value)
	})

	// The two formats agreeing on ASCII is what makes trying the new decode first safe: an
	// old-format ASCII payload is byte-identical to a new-format one, so it never even needs
	// the fallback. This is the property the whole rollout leans on, so it is pinned.
	it('encodes ASCII to the same bytes bare btoa did', () => {
		expect(encodeBase64Utf8('{"clientId":"test-client"}')).toBe(btoa('{"clientId":"test-client"}'))
	})
})

describe('the legacy fallback', () => {
	// Built with the old expression inline, exactly as the retired encoder wrote it. Latin-1 is
	// the only non-ASCII the old format could hold — bare btoa threw on everything above U+00FF
	// — and its single bytes are invalid UTF-8, which is what routes them to the fallback.
	it('decodes a legacy encoding of non-ASCII content', () => {
		const legacy = btoa(JSON.stringify({ clientId: 'test-client', state: 'café' }))

		expect(decodeBase64Json(legacy)).toEqual({ clientId: 'test-client', state: 'café' })
	})

	it('decodes a legacy non-ASCII string payload', () => {
		expect(decodeBase64Utf8(btoa('café'))).toBe('café')
	})

	// Pinned as accepted rather than intended. The fallback is deterministic in one direction
	// only: bytes that fail UTF-8 can only be legacy, but legacy bytes that happen to form
	// valid UTF-8 — here U+00C3 U+00A9, whose Latin-1 bytes are exactly UTF-8 'é' — read as
	// the new format. Telling them apart is not possible from the bytes, and the cost lands as
	// a failed cookie signature or a mangled state field rather than a throw, so nothing
	// worse than a re-approval comes of it.
	it('reads legacy bytes that happen to be valid UTF-8 as the new format', () => {
		expect(decodeBase64Utf8(btoa('Ã©'))).toBe('é')
	})
})

describe('input it cannot read', () => {
	it('throws on characters outside the base64 alphabet', () => {
		expect(() => decodeBase64Utf8('not-valid-base64!!')).toThrow()
		expect(() => decodeBase64Json('not-valid-base64!!')).toThrow()
	})

	it('throws on base64 that does not hold JSON', () => {
		expect(() => decodeBase64Json(encodeBase64Utf8('not json at all'))).toThrow()
	})
})
