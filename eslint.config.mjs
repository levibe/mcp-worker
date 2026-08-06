import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'no-unused-vars': 'off',
			// TypeScript already catches undefined references, and the rule cannot see
			// the Workers globals this codebase compiles against.
			'no-undef': 'off',
			// A leading underscore marks something as deliberately unused, which is how
			// this codebase flags parked helpers and ignored callback arguments.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			// Held at error so an unexamined `any` cannot land silently — while this warned in the
			// repo these modules came from, validate passed with any number of them in the tree,
			// which is how 66 accumulated unnoticed there. No file is exempt, vendored code
			// included; a new `any` anywhere needs its own argued-for exemption.
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'no-console': 'off',
			'prefer-const': 'error',
		},
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
		},
	},
	{
		// `withErrorHandling` turns a handler's result into an MCP response, and `registerTools`
		// applies it to every handler already — so a second call inside a handler can only be a
		// mistake. It encodes the inner response as the text of the outer one, and `isError` goes
		// with it, so a write the upstream API rejected reads back as a successful call. Nothing
		// about that looks wrong until a write fails, which is how it came to be true of every
		// write handler in the zendesk tree at once (zendesk-mcp-cloudflare#28). A worded
		// confirmation is what those handlers actually wanted, and it travels as the final
		// argument to the app's `createTool`.
		//
		// The exemptions are the file defining it, the one call site, the barrel that re-exports
		// it (a re-export is an import to this rule, and the barrel is how consumers receive the
		// function at all), and tests — tests because that is where the double-wrapped shape is
		// pinned, and nothing there ships. Consumers should carry the same guard; the README has
		// the copy-paste snippet.
		files: ['src/**/*.ts'],
		ignores: [
			'src/registry/error-handling.ts',
			'src/registry/tool-registry.ts',
			'src/registry/index.ts',
			'src/**/*.test.ts',
		],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/error-handling'],
							importNames: ['withErrorHandling'],
							message:
								'registerTools wraps every handler in withErrorHandling already. Wrapping again encodes the response as text and drops its isError, reporting a failed write as a success — return the client result and pass a successMessage to the tool factory instead.',
						},
					],
				},
			],
		},
	},
	// Must stay last so it switches off every formatting rule enabled above and
	// leaves Prettier as the only thing with an opinion about layout.
	prettier,
	{
		ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.js', '*.mjs', '*.cjs', '*.d.ts'],
	}
)
