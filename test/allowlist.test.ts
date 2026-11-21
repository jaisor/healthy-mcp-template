import { describe, expect, it } from "vitest";
import allowedUsers from "../config/allowed-users.json";
import { type AllowedUser, isAllowed } from "../src/allowlist";

const users: AllowedUser[] = [{ github_id: 1001, login: "a" }, { github_id: 1002 }, { google_email: "Person@Example.com" }];

describe("isAllowed: GitHub", () => {
	it("allows listed ids, as numbers or strings", () => {
		expect(isAllowed({ githubId: 1002 }, users)).toBe(true);
		expect(isAllowed({ githubId: "1001" }, users)).toBe(true);
	});
	it("refuses ids that are not listed, including partial matches and logins", () => {
		expect(isAllowed({ githubId: 1003 }, users)).toBe(false);
		expect(isAllowed({ githubId: 100 }, users)).toBe(false);
		expect(isAllowed({ githubId: 11001 }, users)).toBe(false);
		expect(isAllowed({ githubId: "a" }, users)).toBe(false);
	});
	it("fails closed when the list is empty or holds junk", () => {
		expect(isAllowed({ githubId: 1001 }, [])).toBe(false);
		expect(isAllowed({ githubId: 1001 }, [{ github_id: "1001" as any }, { github_id: NaN }])).toBe(false);
	});
});

describe("isAllowed: Google", () => {
	it("allows a listed email, ignoring case and spaces", () => {
		expect(isAllowed({ googleEmail: "person@example.com" }, users)).toBe(true);
		expect(isAllowed({ googleEmail: " PERSON@example.COM " }, users)).toBe(true);
	});
	it("refuses emails that are not listed, partial matches and junk", () => {
		expect(isAllowed({ googleEmail: "other@example.com" }, users)).toBe(false);
		expect(isAllowed({ googleEmail: "person@example.co" }, users)).toBe(false);
		expect(isAllowed({ googleEmail: "" }, users)).toBe(false);
		expect(isAllowed({ googleEmail: "a" }, users)).toBe(false);
	});
	it("does not let an email match a GitHub entry, or the other way round", () => {
		expect(isAllowed({ googleEmail: "1001" }, users)).toBe(false);
		expect(isAllowed({ githubId: 1001 }, [{ google_email: "1001" }])).toBe(false);
	});
	it("fails closed when the list is empty or the identity is empty", () => {
		expect(isAllowed({ googleEmail: "person@example.com" }, [])).toBe(false);
		expect(isAllowed({}, users)).toBe(false);
	});
});

describe("config/allowed-users.json", () => {
	it("is a list where every entry has a numeric github_id or a google_email, with no repeats", () => {
		expect(Array.isArray(allowedUsers)).toBe(true);
		const entries = allowedUsers as AllowedUser[];
		for (const u of entries) {
			const github = Number.isSafeInteger(u.github_id) && u.github_id! > 0;
			const google = typeof u.google_email === "string" && u.google_email.includes("@");
			expect(github !== google).toBe(true); // exactly one kind per entry
		}
		const keys = entries.map((u) => (u.github_id !== undefined ? `gh:${u.github_id}` : `g:${u.google_email!.toLowerCase()}`));
		expect(new Set(keys).size).toBe(keys.length);
	});
});
