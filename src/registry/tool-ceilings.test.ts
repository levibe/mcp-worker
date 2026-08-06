import { describe, expect, it } from 'vitest'
import { isWithinCeiling, resolveCeilings } from './tool-ceilings'

const GROUPS = ['tickets', 'macros'] as const

const allRead = { tickets: 'read', macros: 'read' }

describe('isWithinCeiling', () => {
	it('orders the levels read < stage < write < delete', () => {
		expect(isWithinCeiling('read', 'read')).toBe(true)
		expect(isWithinCeiling('stage', 'read')).toBe(false)
		expect(isWithinCeiling('stage', 'stage')).toBe(true)
		expect(isWithinCeiling('write', 'stage')).toBe(false)
		expect(isWithinCeiling('write', 'write')).toBe(true)
		expect(isWithinCeiling('delete', 'write')).toBe(false)
		expect(isWithinCeiling('delete', 'delete')).toBe(true)
	})
})

describe('resolveCeilings', () => {
	it('resolves a well-formed config to its ceilings, with no error', () => {
		const resolved = resolveCeilings({ tickets: 'read', macros: 'stage' }, GROUPS)

		expect(resolved).toEqual({ ceilings: { tickets: 'read', macros: 'stage' } })
	})

	// .dev.vars can shadow the var locally, and everything arriving from there is a string.
	it('accepts the config as a JSON string, which is what .dev.vars would hand it', () => {
		const resolved = resolveCeilings('{"tickets":"read","macros":"stage"}', GROUPS)

		expect(resolved.ceilings).toEqual({ tickets: 'read', macros: 'stage' })
		expect(resolved.error).toBeUndefined()
	})

	it('fails closed to read on every group when the var is not set', () => {
		const resolved = resolveCeilings(undefined, GROUPS)

		expect(resolved.ceilings).toEqual(allRead)
		expect(resolved.error).toContain('not set')
	})

	it('fails closed when the string is not JSON at all', () => {
		const resolved = resolveCeilings('macros: stage', GROUPS)

		expect(resolved.ceilings).toEqual(allRead)
		expect(resolved.error).toContain('not valid JSON')
	})

	it('fails closed when a group is missing', () => {
		const resolved = resolveCeilings({ tickets: 'read' }, GROUPS)

		expect(resolved.ceilings).toEqual(allRead)
		expect(resolved.error).toContain('macros')
	})

	// A typo'd group name must not half-apply: 'macro' at stage alongside a missing 'macros'
	// silently at read is exactly the misconfiguration strictness exists to refuse whole.
	it('fails closed when an unknown group is named', () => {
		const resolved = resolveCeilings({ tickets: 'read', macros: 'stage', macro: 'stage' }, GROUPS)

		expect(resolved.ceilings).toEqual(allRead)
		expect(resolved.error).toBeDefined()
	})

	it('fails closed on a level outside the vocabulary', () => {
		const resolved = resolveCeilings({ tickets: 'read', macros: 'admin' }, GROUPS)

		expect(resolved.ceilings).toEqual(allRead)
		expect(resolved.error).toContain('macros')
	})

	// The reserved word. No ceiling may permit activation, so as a config value it is exactly
	// as malformed as a word the vocabulary never contained.
	it('refuses activate as a ceiling', () => {
		const resolved = resolveCeilings({ tickets: 'read', macros: 'activate' }, GROUPS)

		expect(resolved.ceilings).toEqual(allRead)
		expect(resolved.error).toContain('macros')
	})
})
