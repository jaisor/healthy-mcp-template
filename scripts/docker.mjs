// The Docker alternative to the Cloudflare deploy: the same Worker bundle runs on workerd (Cloudflare's open-source
// runtime) through Miniflare, and D1 and KV are SQLite files under DATA_DIR. See docs/docker.md.
//
//   node scripts/docker.mjs prepare   at image build time, after `wrangler deploy --dry-run --outdir dist`:
//                                     checks config/allowed-users.json, splits migrations/ into statements and writes
//                                     dist/docker-config.json (runtime settings from wrangler.jsonc, and the migrations)
//   node scripts/docker.mjs serve     in the container: checks the environment, applies pending migrations, serves
//
// Environment for serve: PUBLIC_URL (the https address people reach, no path), the six secrets listed in REQUIRED_SECRETS,
// and optionally PORT (8788), DATA_DIR (/data) and GIT_SHA.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_SECRETS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "COOKIE_ENCRYPTION_KEY", "USDA_API_KEY"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Same rule as the Deploy workflow: a non-empty list where every entry has a numeric github_id or a google_email, not both. */
export function checkAllowlist(users) {
	const entry = (x) => (Number.isSafeInteger(x?.github_id) && x.google_email === undefined) || (typeof x?.google_email === "string" && x.google_email.includes("@") && x.github_id === undefined);
	if (!Array.isArray(users) || users.length === 0 || !users.every(entry)) {
		throw new Error("config/allowed-users.json must be a non-empty list where every entry has either a numeric github_id or a google_email (see the README). It is built into the image, so fix it and build again.");
	}
}

/** What serve needs from wrangler.jsonc and migrations/, so the image needs neither wrangler nor the sources. */
export function buildDockerConfig(wrangler, migrations) {
	const d1 = wrangler.d1_databases?.[0];
	const kv = wrangler.kv_namespaces?.[0];
	if (!d1 || !kv) throw new Error("wrangler.jsonc must have a d1_databases and a kv_namespaces entry");
	return {
		compatibilityDate: wrangler.compatibility_date,
		compatibilityFlags: wrangler.compatibility_flags ?? [],
		d1Binding: d1.binding,
		kvBinding: kv.binding,
		ratelimits: Object.fromEntries((wrangler.ratelimits ?? []).map(({ name, ...rest }) => [name, rest])),
		migrations,
	};
}

/** Every .sql file in `dir`, in name order (as wrangler applies them), split into single statements by `split`. */
export function readMigrations(dir, split) {
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, queries: split(fs.readFileSync(path.join(dir, name), "utf8")) }));
}

/**
 * Applies the migrations not yet recorded in d1_migrations (the table wrangler uses), oldest first. Each migration and
 * its record are one db.batch, which is one transaction: a migration is applied completely or not at all.
 */
export async function applyMigrations(db, migrations) {
	await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
	const done = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map((r) => r.name));
	const applied = [];
	for (const m of migrations) {
		if (done.has(m.name)) continue;
		await db.batch([...m.queries.map((q) => db.prepare(q)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name)]);
		applied.push(m.name);
	}
	return applied;
}

/** Checks the environment and returns the settings for serve. Throws one error that names everything missing. */
export function readServeEnv(env) {
	const missing = ["PUBLIC_URL", ...REQUIRED_SECRETS].filter((k) => !env[k]);
	if (missing.length > 0) throw new Error(`Not set: ${missing.join(", ")}. See docs/docker.md.`);

	let u;
	try {
		u = new URL(env.PUBLIC_URL);
	} catch {
		throw new Error(`PUBLIC_URL must be a full address like https://health.example.com, got: ${env.PUBLIC_URL}`);
	}
	if (u.pathname !== "/" || u.search || u.hash) throw new Error("PUBLIC_URL must have no path, for example https://health.example.com");
	// Tokens are bound to PUBLIC_URL/mcp, and the sign-in cookies are Secure: only a local address may be plain http.
	if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
		throw new Error("PUBLIC_URL must be https (plain http only for localhost). Put an HTTPS proxy in front: see docs/docker.md.");
	}

	const port = Number(env.PORT ?? 8788);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a port number, got: ${env.PORT}`);
	return {
		publicUrl: u.origin,
		port,
		dataDir: env.DATA_DIR || "/data",
		vars: {
			MCP_RESOURCE: `${u.origin}/mcp`,
			GIT_SHA: env.GIT_SHA || "unknown",
			...Object.fromEntries(REQUIRED_SECRETS.map((k) => [k, env[k]])),
		},
	};
}

/**
 * The Miniflare options (in the documented v4 form; serve converts them with convertV4MiniflareOptions):
 * the Worker as wrangler bundled it, its bindings, and storage under dataDir.
 */
export function miniflareOptions(serve, config, { distDir, distFiles, host, port }) {
	return {
		host,
		port,
		resourcePersistencePath: serve.dataDir,
		// Every request.url is rewritten to the public address, so OAuth redirect URIs and the token audience are right behind a proxy.
		upstream: serve.publicUrl,
		// The app never reads request.cf; without this, Miniflare downloads a sample one from Cloudflare at every start.
		cf: false,
		// The bundle, and the markdown files wrangler wrote next to it (the "rules" entry in wrangler.jsonc makes them Text modules).
		modulesRoot: distDir,
		modules: [
			{ type: "ESModule", path: path.join(distDir, "index.js") },
			...distFiles.filter((f) => f.endsWith(".md")).map((f) => ({ type: "Text", path: path.join(distDir, f) })),
		],
		compatibilityDate: config.compatibilityDate,
		compatibilityFlags: config.compatibilityFlags,
		bindings: serve.vars,
		d1Databases: { [config.d1Binding]: "healthy-db" },
		kvNamespaces: { [config.kvBinding]: "oauth" },
		ratelimits: config.ratelimits,
	};
}

async function prepare() {
	checkAllowlist(JSON.parse(fs.readFileSync("config/allowed-users.json", "utf8")));
	// Build-time only (the image has neither wrangler nor provision.mjs). wrangler's own splitter splits statements exactly as for D1.
	const { unstable_splitSqlQuery } = await import("wrangler");
	const { parseJsonc } = await import("./provision.mjs");
	const wrangler = parseJsonc(fs.readFileSync("wrangler.jsonc", "utf8"));
	const config = buildDockerConfig(wrangler, readMigrations(wrangler.d1_databases[0].migrations_dir ?? "migrations", unstable_splitSqlQuery));
	fs.writeFileSync("dist/docker-config.json", JSON.stringify(config, null, 2) + "\n");
	console.log(`Wrote dist/docker-config.json (${config.migrations.length} migrations)`);
}

async function serve() {
	const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import("miniflare");
	const distDir = path.resolve("dist");
	const config = JSON.parse(fs.readFileSync(path.join(distDir, "docker-config.json"), "utf8"));
	const settings = readServeEnv(process.env);
	fs.mkdirSync(settings.dataDir, { recursive: true });
	const distFiles = fs.readdirSync(distDir);
	const start = (host, port, extra = {}) => new Miniflare(convertV4MiniflareOptions({ ...miniflareOptions(settings, config, { distDir, distFiles, host, port }), ...extra }));

	// Migrate first on a private loopback port, so no request ever reaches a database that is not up to date.
	const migrator = start("127.0.0.1", 0);
	try {
		const applied = await applyMigrations(await migrator.getD1Database(config.d1Binding), config.migrations);
		console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date");
	} finally {
		await migrator.dispose();
	}

	const mf = start("0.0.0.0", settings.port, { log: new Log(LogLevel.INFO) });
	await mf.ready;
	// On SIGTERM (docker stop) Miniflare's own exit hook stops workerd, and the process ends with the signal's exit code (143).
	console.log(`Serving on port ${settings.port}. Connector URL: ${settings.vars.MCP_RESOURCE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = process.argv[2] ?? "serve";
	const run = { prepare, serve }[command];
	if (!run) {
		console.error(`unknown command ${command}: use prepare or serve`);
		process.exit(1);
	}
	run().catch((e) => {
		console.error(`docker ${command} failed: ${e.message}`);
		process.exit(1);
	});
}
