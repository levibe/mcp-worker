export function getUpstreamAuthorizeUrl({
	upstreamUrl,
	clientId,
	scope,
	redirectUri,
	state,
	hostedDomain,
}: {
	upstreamUrl: string
	clientId: string
	scope: string
	redirectUri: string
	state?: string
	hostedDomain?: string
}) {
	const upstream = new URL(upstreamUrl)
	upstream.searchParams.set('client_id', clientId)
	upstream.searchParams.set('redirect_uri', redirectUri)
	upstream.searchParams.set('scope', scope)
	upstream.searchParams.set('response_type', 'code')
	if (state) upstream.searchParams.set('state', state)
	if (hostedDomain) upstream.searchParams.set('hd', hostedDomain)
	return upstream.href
}

/** Resolves to `[token, null]` on success and `[null, response]` with the error to return. */
export async function fetchUpstreamAuthToken({
	clientId,
	clientSecret,
	code,
	redirectUri,
	upstreamUrl,
	grantType,
}: {
	code: string | undefined
	upstreamUrl: string
	clientSecret: string
	redirectUri: string
	clientId: string
	grantType: string
}): Promise<[string, null] | [null, Response]> {
	if (!code) {
		return [null, new Response('Missing code', { status: 400 })]
	}

	const resp = await fetch(upstreamUrl, {
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code: code,
			grant_type: grantType,
			redirect_uri: redirectUri,
		}).toString(),
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		method: 'POST',
	})
	if (!resp.ok) {
		console.log(await resp.text())
		return [null, new Response('Failed to fetch access token', { status: 500 })]
	}

	interface authTokenResponse {
		access_token: string
	}

	const body = (await resp.json()) as authTokenResponse
	if (!body.access_token) {
		return [null, new Response('Missing access token', { status: 400 })]
	}
	return [body.access_token, null]
}

// Context from the auth process, encrypted into the access token by OAuthProvider and
// readable inside a tool through getMcpAuthContext(). Nothing reads it today — the Zendesk
// credentials come from `env`, not from the signed-in user — so this describes what the
// token carries rather than something the server currently acts on.
export type Props = {
	name: string
	email: string
	accessToken: string
}
