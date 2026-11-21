/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstream_url - The base URL of the upstream service.
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (state) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

/**
 * Fetches an authorization token from an upstream service.
 *
 * @param {Object} options
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.client_secret - The client secret of the application.
 * @param {string} options.code - The authorization code.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} options.upstream_url - The token endpoint URL of the upstream service.
 *
 * @returns {Promise<[string, null] | [null, Response]>} A promise that resolves to an array containing the access token or an error response.
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[string, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		console.log(await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const body = await resp.formData();
	const accessToken = body.get("access_token") as string;
	if (!accessToken) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [accessToken, null];
}

/**
 * Google's answer to the code exchange is JSON (GitHub's is a form, so it has its own function above).
 * Returns who signed in, read from the id_token. The id_token comes straight from Google's token endpoint over TLS,
 * in exchange for our client secret, so its signature does not need checking; its audience, issuer and
 * email_verified still do. Only a verified email is ever returned. `fetchFn` is injectable so tests never touch the network.
 */
export async function fetchGoogleIdentity(
	{ client_id, client_secret, code, redirect_uri }: { client_id: string; client_secret: string; code: string | undefined; redirect_uri: string },
	fetchFn: typeof fetch = fetch,
): Promise<[{ sub: string; email: string }, null] | [null, Response]> {
	if (!code) return [null, new Response("Missing code", { status: 400 })];
	const resp = await fetchFn("https://oauth2.googleapis.com/token", {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri, grant_type: "authorization_code" }).toString(),
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		method: "POST",
	});
	if (!resp.ok) return [null, new Response("Failed to sign in with Google", { status: 502 })];
	const idToken = ((await resp.json()) as { id_token?: unknown }).id_token;
	if (typeof idToken !== "string") return [null, new Response("Google did not return an id_token", { status: 502 })];

	let claims: { aud?: unknown; iss?: unknown; sub?: unknown; email?: unknown; email_verified?: unknown; exp?: unknown };
	try {
		const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
		claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
	} catch {
		return [null, new Response("Google returned an unreadable id_token", { status: 502 })];
	}
	if (claims.aud !== client_id) return [null, new Response("The Google sign-in was for a different app", { status: 403 })];
	if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return [null, new Response("The Google sign-in has an unexpected issuer", { status: 403 })];
	if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return [null, new Response("The Google sign-in has expired. Try again.", { status: 403 })];
	if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string") return [null, new Response("Google did not say who signed in", { status: 502 })];
	if (claims.email_verified !== true) return [null, new Response("Your Google email is not verified.", { status: 403 })];
	return [{ sub: claims.sub, email: claims.email.toLowerCase() }, null];
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to MCP handlers through getMcpAuthContext()
export type Props = {
	/** Our users.id (a UUID). Tool handlers use this and never accept a user id as input. */
	userId: string;
	/** GitHub's numeric id, for people who signed in with GitHub. Re-checked against the allowlist on every request, so removing someone takes effect at once. */
	githubId?: number;
	/** GitHub login, for display only; it can change, so it is never used as an identity. */
	login?: string;
	/** The verified email of people who signed in with Google. Re-checked against the allowlist on every request. */
	googleEmail?: string;
};
