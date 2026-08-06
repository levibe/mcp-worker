import { defineConfig } from 'vitest/config'

import { coverageThresholds } from './vitest.thresholds'

export default defineConfig({
	test: {
		// Tests sit next to the code they cover, so `pnpm run lint` and `tsc --noEmit`
		// already reach them without either one needing a second path to look at.
		include: ['src/**/*.test.ts'],
		// Undo spies and stubbed globals between tests here rather than leaving each file to
		// remember an afterEach. Both matter to this suite: it stubs `fetch` to keep the
		// transport off the network, and silences the console output the retry and registry
		// paths emit. Timers are still each file's own to restore, since vitest has no
		// equivalent switch for them.
		restoreMocks: true,
		unstubGlobals: true,
		// Scaffold-only: removed when the lifted suite lands with the modules it covers.
		passWithNoTests: true,
		coverage: {
			provider: 'v8',
			// text and html are for reading locally. Run through a coding agent, the text
			// table is a summary rather than the whole picture: Vitest turns `skipFull` on
			// for the text reporter whenever std-env reports an agent, so files at 100% on
			// all four metrics drop out and a directory can print a middling percentage
			// with its finished files nowhere in the listing. Setting `coverage.skipFull`
			// back to false does not undo it, because the override is applied to the
			// reporter's own options, which win. From a plain terminal, and on CI, none of
			// that applies and every file is listed. The html report always has all of
			// them, so open that before concluding something is uncovered.
			//
			// The two json reporters exist for CI rather than for people. The reporting
			// action requires json-summary for the totals, and reads json for the per-file
			// detail it puts in the pull request comment.
			reporter: ['text', 'html', 'json-summary', 'json'],
			// Write the reports even when the run fails. A failing suite is exactly when the
			// comment on the pull request has something to say, and without this the run
			// goes red having produced nothing to explain itself.
			reportOnFailure: true,
			// Report on all of src/, not just the files a test happened to import. Without
			// this, a module nobody tests is absent from the table rather than sitting in it
			// at 0% — which reads as "nothing to see here" for exactly the files that need
			// looking at. The number is meant to show where the holes are, so the vendored
			// OAuth code and the barrels have to be in the denominator.
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
			// Per file rather than one figure over all of src/. The overall number is
			// diluted on purpose by the include above, so a floor under it would mostly
			// reward covering passthrough code — and would let a real branch test be
			// deleted from the transport so long as one more thin module got covered.
			// There is no global threshold here, only the per-file ones.
			//
			// They are imported rather than written inline because the reporting action
			// on CI reads this file with a regex per metric and treats the first hit as a
			// target for the whole project. See vitest.thresholds.ts, which explains what
			// that did to the comment and why the numbers have to stay over there.
			thresholds: coverageThresholds,
		},
	},
})
