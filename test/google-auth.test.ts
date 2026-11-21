// Google sign-in: the code exchange and the checks on the id_token, and the consent page's two buttons.
import { describe, expect, it } from "vitest";
import { fetchGoogleIdentity } from "../src/utils";
import { renderApprovalDialog } from "../src/workers-oauth-utils";
import { json, mockFetch } from "./helpers";

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.signature`;
const good = { aud: CLIENT_ID, iss: "https://accounts.google.com", sub: "1078", email: "Person@Example.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 };

async function signIn(claims: Record<string, unknown> | null, status = 200, opts: { code?: string } = { code: "the-code" }) {
	const { fn, calls } = mockFetch(() => (status === 200 ? json(claims ? { id_token: idToken(claims), access_token: "x" } : { access_token: "x" }) : json({ error: "invalid_grant" }, status)));
	const result = await fetchGoogleIdentity({ client_id: CLIENT_ID, client_secret: "secret", code: opts.code, redirect_uri: "https://h.example/callback/google" }, fn);
	return { result, calls };
}

describe("fetchGoogleIdentity", () => {
	it("returns the account id and the lowercased verified email", async () => {
		const { result, calls } = await signIn(good);
		expect(result).toEqual([{ sub: "1078", email: "person@example.com" }, null]);
		expect(calls[0].url.href).toBe("https://oauth2.googleapis.com/token");
	});

	it("accepts the issuer without https://", async () => {
		const [who] = (await signIn({ ...good, iss: "accounts.google.com" })).result;
		expect(who?.sub).toBe("1078");
	});

	it.each([
		["an unverified email", { email_verified: false }, 403],
		["email_verified sent as a string", { email_verified: "true" }, 403],
		["a token for another app", { aud: "someone-else" }, 403],
		["another issuer", { iss: "https://evil.example" }, 403],
		["an expired token", { exp: Math.floor(Date.now() / 1000) - 60 }, 403],
		["no sub", { sub: undefined }, 502],
		["no email", { email: undefined }, 502],
	])("refuses %s", async (_name, change, status) => {
		const [who, err] = (await signIn({ ...good, ...change })).result;
		expect(who).toBeNull();
		expect(err?.status).toBe(status);
	});

	it("refuses when Google rejects the code, returns no id_token, or no code was given", async () => {
		expect((await signIn(good, 400)).result[1]?.status).toBe(502);
		expect((await signIn(null)).result[1]?.status).toBe(502);
		const { result, calls } = await signIn(good, 200, {});
		expect(result[1]?.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("refuses an id_token it cannot read", async () => {
		const { fn } = mockFetch(() => json({ id_token: "not-a-jwt" }));
		const [, err] = await fetchGoogleIdentity({ client_id: CLIENT_ID, client_secret: "s", code: "c", redirect_uri: "r" }, fn);
		expect(err?.status).toBe(502);
	});
});

describe("consent page", () => {
	it("offers both GitHub and Google, inside the CSRF-protected form", async () => {
		const res = renderApprovalDialog(new Request("https://h.example/authorize"), {
			client: null,
			server: { name: "Healthy" },
			state: { oauthReqInfo: { clientId: "c" } },
			csrfToken: "tok",
			setCookie: "x=y",
		});
		const html = await res.text();
		expect(html).toContain('name="provider" value="github"');
		expect(html).toContain('name="provider" value="google"');
		expect(html).toContain('name="csrf_token" value="tok"');
	});
});
