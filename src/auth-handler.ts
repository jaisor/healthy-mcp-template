import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { type Identity, isAllowed } from "./allowlist";
import { findOrCreateUser } from "./data";
import { fetchGoogleIdentity, fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

export type Provider = "github" | "google";

// The consent page is always shown (even for an app approved before), so the person can pick GitHub or Google each time.
app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Generate CSRF protection for the approval form
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Your private macro coach. Signing in with GitHub or Google keeps your food log yours.",
			name: "Healthy",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		const { clearCookie: clearCsrfCookie } = validateCSRFToken(formData, c.req.raw);

		// Which button was pressed
		const provider = formData.get("provider");
		if (provider !== "github" && provider !== "google") {
			return c.text("Choose GitHub or Google", 400);
		}

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Approved-client list, session binding, and clearing the one-time CSRF token.
		return redirectToProvider(provider, c.req.raw, stateToken, [approvedClientCookie, sessionBindingCookie, clearCsrfCookie]);
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}
});

export function redirectToProvider(provider: Provider, request: Request, stateToken: string, cookies: string[]) {
	const location =
		provider === "github"
			? getUpstreamAuthorizeUrl({
					client_id: env.GITHUB_CLIENT_ID,
					redirect_uri: new URL("/callback", request.url).href,
					scope: "", // no extra permission: the public profile (id and login) is all we read
					state: stateToken,
					upstream_url: "https://github.com/login/oauth/authorize",
				})
			: getUpstreamAuthorizeUrl({
					client_id: env.GOOGLE_CLIENT_ID,
					redirect_uri: new URL("/callback/google", request.url).href,
					scope: "openid email", // who you are and your verified email; nothing else
					state: stateToken,
					upstream_url: "https://accounts.google.com/o/oauth2/v2/auth",
				});
	const headers = new Headers({ location });
	// One Set-Cookie header per cookie (a plain object would keep only the last).
	for (const c of cookies) headers.append("Set-Cookie", c);
	return new Response(null, { headers, status: 302 });
}

/**
 * Checks the state (SECURITY: it must be in KV, which proves our server made it, AND match the __Host-CONSENTED_STATE
 * cookie, which proves THIS browser consented to it; that stops an attacker's state being injected into a victim's flow).
 */
async function readState(c: Context<{ Bindings: Bindings }>): Promise<[{ oauthReqInfo: AuthRequest; clearCookie: string }, null] | [null, Response]> {
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		if (!result.oauthReqInfo.clientId) return [null, c.text("Invalid OAuth request data", 400)];
		return [result, null];
	} catch (error: any) {
		if (error instanceof OAuthError) return [null, error.toResponse()];
		// Unexpected non-OAuth error
		return [null, c.text("Internal server error", 500)];
	}
}

/**
 * The end of every sign-in: refuse anyone not on the allowlist (before any user row is created), find or create
 * our user, and send the MCP client back with a new token. The upstream access token is never kept.
 */
async function finishSignIn(
	c: Context<{ Bindings: Bindings }>,
	state: { oauthReqInfo: AuthRequest; clearCookie: string },
	who: { provider: Provider; subject: string; identity: Identity; props: Omit<Props, "userId">; label: string; refusal: string },
) {
	if (!isAllowed(who.identity)) {
		console.warn(`sign-in refused: a ${who.provider} account that is not on the allowlist`); // never log the email
		return c.text(`This server is private. ${who.refusal}`, 403);
	}

	// First sign-in creates our users row and default settings; later sign-ins find it.
	const dbUser = await findOrCreateUser(c.env.DB, { provider: who.provider, subject: who.subject });

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: who.label },
		// This will be available through getMcpAuthContext() in MCP handlers.
		props: { userId: dbUser.id, ...who.props } satisfies Props,
		request: state.oauthReqInfo,
		scope: state.oauthReqInfo.scope,
		userId: dbUser.id,
	});

	// Clear the session binding cookie (one-time use).
	const headers = new Headers({ Location: redirectTo });
	if (state.clearCookie) headers.set("Set-Cookie", state.clearCookie);
	return new Response(null, { status: 302, headers });
}

// GitHub sends the person back here with a code.
app.get("/callback", async (c) => {
	const [state, stateError] = await readState(c);
	if (stateError) return stateError;

	// Exchange the code for an access token
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	// Fetch the user info from GitHub. The numeric id is the stable identity (logins can be renamed).
	const userResp = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "Healthy" },
	});
	if (!userResp.ok) return c.text("Could not read your GitHub profile", 502);
	const { login, name, id: githubId } = (await userResp.json()) as { login: string; name: string | null; id: number };

	return finishSignIn(c, state, {
		provider: "github",
		subject: String(githubId),
		identity: { githubId },
		props: { githubId, login },
		label: name ?? login,
		refusal: "Your GitHub account is not on the allowed list.",
	});
});

// Google sends the person back here with a code.
app.get("/callback/google", async (c) => {
	const [state, stateError] = await readState(c);
	if (stateError) return stateError;

	const [google, errResponse] = await fetchGoogleIdentity({
		client_id: c.env.GOOGLE_CLIENT_ID,
		client_secret: c.env.GOOGLE_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback/google", c.req.url).href,
	});
	if (errResponse) return errResponse;

	// The stable Google account id (sub) is the identity in our database; the verified email is what the allowlist lists.
	return finishSignIn(c, state, {
		provider: "google",
		subject: google.sub,
		identity: { googleEmail: google.email },
		props: { googleEmail: google.email },
		label: google.email,
		refusal: "Your Google account is not on the allowed list.",
	});
});

export { app as AuthHandler };
