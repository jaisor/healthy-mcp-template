// Who may sign in: the people listed in config/allowed-users.json (committed, reviewed like any other code).
// A GitHub entry lists the numeric id, not the login, because logins can be renamed and then claimed by someone else.
// A Google entry lists the email; only emails Google has verified ever reach this check.
// Fails closed: an empty list means nobody can sign in.
import allowedUsers from "../config/allowed-users.json";

export interface AllowedUser {
	github_id?: number;
	/** A label for humans reading the file. Never used for the check. */
	login?: string;
	google_email?: string;
}

/** Who is signing in: a GitHub id, or a verified Google email. */
export interface Identity {
	githubId?: number | string;
	googleEmail?: string;
}

export function isAllowed(identity: Identity, users: AllowedUser[] = allowedUsers as AllowedUser[]): boolean {
	if (identity.githubId !== undefined) {
		const id = String(identity.githubId);
		if (!/^\d+$/.test(id)) return false;
		return users.some((u) => Number.isSafeInteger(u.github_id) && String(u.github_id) === id);
	}
	if (identity.googleEmail !== undefined) {
		const email = identity.googleEmail.trim().toLowerCase();
		if (!email.includes("@")) return false;
		return users.some((u) => typeof u.google_email === "string" && u.google_email.trim().toLowerCase() === email);
	}
	return false;
}
