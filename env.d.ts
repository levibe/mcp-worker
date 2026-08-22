// The package's stand-in for the `Env` a consumer's `wrangler types` generates.
//
// In a consuming Worker, `Env` is a generated global, and the consumer hand-maintains a
// companion env.d.ts merging its secrets into it because the generator cannot see them —
// the README documents that pattern. The lifted OAuth handler tests were written against
// such an `Env`, so the package supplies one of its own: the handler's secret contract
// and nothing else. It sits outside src/ so the build never sees it and nothing ambient
// ships to consumers.
interface Env {
	GOOGLE_CLIENT_ID: string
	GOOGLE_CLIENT_SECRET: string
	COOKIE_ENCRYPTION_KEY: string
	// Optional: when set, restricts Google sign-in to a single hosted domain
	HOSTED_DOMAIN?: string
	// Optional: when set, restricts Google sign-in to a comma-separated list of exact addresses
	ALLOWED_EMAILS?: string
}
