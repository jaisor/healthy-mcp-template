// Tests for scripts/docker.mjs on node:test, with a fake D1. Run: npm run test:scripts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyMigrations, buildDockerConfig, checkAllowlist, miniflareOptions, readMigrations, readServeEnv, REQUIRED_SECRETS } from "./docker.mjs";

const secrets = Object.fromEntries(REQUIRED_SECRETS.map((k) => [k, `${k}-value`]));

/** A fake D1 that records every batch, and remembers the d1_migrations rows. */
function fakeDb(alreadyApplied = []) {
	const applied = [...alreadyApplied];
	const batches = [];
	const db = {
		prepare(sql) {
			const stmt = {
				sql,
				args: [],
				bind: (...args) => ({ ...stmt, args }),
				run: async () => ({}),
				all: async () => ({ results: sql.startsWith("SELECT name FROM d1_migrations") ? applied.map((name) => ({ name })) : [] }),
			};
			return stmt;
		},
		async batch(stmts) {
			batches.push(stmts.map((s) => s.sql));
			const record = stmts.at(-1);
			if (record.sql.startsWith("INSERT INTO d1_migrations")) applied.push(record.args[0]);
		},
	};
	return { db, applied, batches };
}

test("checkAllowlist: refuses an empty list, a bad entry, or an entry with both ids", () => {
	assert.throws(() => checkAllowlist([]), /non-empty/);
	assert.throws(() => checkAllowlist({}), /non-empty/);
	assert.throws(() => checkAllowlist([{ login: "someone" }]), /non-empty/);
	assert.throws(() => checkAllowlist([{ github_id: "123" }]), /non-empty/);
	assert.throws(() => checkAllowlist([{ github_id: 1, google_email: "a@b.c" }]), /non-empty/);
	checkAllowlist([{ github_id: 12345678, login: "me" }, { google_email: "me@example.com" }]);
});

test("buildDockerConfig: takes the runtime settings from wrangler.jsonc", () => {
	const wrangler = {
		compatibility_date: "2025-03-10",
		compatibility_flags: ["nodejs_compat"],
		kv_namespaces: [{ binding: "OAUTH_KV", id: "x" }],
		d1_databases: [{ binding: "DB", database_name: "d", database_id: "x" }],
		ratelimits: [{ name: "AUTH_LIMIT", namespace_id: "1001", simple: { limit: 20, period: 60 } }],
	};
	const migrations = [{ name: "0001.sql", queries: ["CREATE TABLE t (x)"] }];
	assert.deepEqual(buildDockerConfig(wrangler, migrations), {
		compatibilityDate: "2025-03-10",
		compatibilityFlags: ["nodejs_compat"],
		d1Binding: "DB",
		kvBinding: "OAUTH_KV",
		ratelimits: { AUTH_LIMIT: { namespace_id: "1001", simple: { limit: 20, period: 60 } } },
		migrations,
	});
	assert.throws(() => buildDockerConfig({ kv_namespaces: [] }, []), /d1_databases/);
});

test("readMigrations: only .sql files, in name order, each split into statements", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
	fs.writeFileSync(path.join(dir, "0002_b.sql"), "B1;B2;");
	fs.writeFileSync(path.join(dir, "0001_a.sql"), "A1;");
	fs.writeFileSync(path.join(dir, "notes.txt"), "not a migration");
	const split = (sql) => sql.split(";").filter(Boolean);
	assert.deepEqual(readMigrations(dir, split), [
		{ name: "0001_a.sql", queries: ["A1"] },
		{ name: "0002_b.sql", queries: ["B1", "B2"] },
	]);
	fs.rmSync(dir, { recursive: true });
});

test("applyMigrations: applies only what is new, each migration in one batch with its record", async () => {
	const { db, applied, batches } = fakeDb(["0001_a.sql"]);
	const migrations = [
		{ name: "0001_a.sql", queries: ["A1"] },
		{ name: "0002_b.sql", queries: ["B1", "B2"] },
		{ name: "0003_c.sql", queries: ["C1"] },
	];
	assert.deepEqual(await applyMigrations(db, migrations), ["0002_b.sql", "0003_c.sql"]);
	assert.deepEqual(batches, [
		["B1", "B2", "INSERT INTO d1_migrations (name) VALUES (?)"],
		["C1", "INSERT INTO d1_migrations (name) VALUES (?)"],
	]);
	assert.deepEqual(applied, ["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
	assert.deepEqual(await applyMigrations(db, migrations), [], "a second run applies nothing");
});

test("readServeEnv: names everything that is missing", () => {
	assert.throws(() => readServeEnv({}), (e) => e.message.includes("PUBLIC_URL") && REQUIRED_SECRETS.every((k) => e.message.includes(k)));
	assert.throws(() => readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com", GITHUB_CLIENT_SECRET: "" }), /Not set: GITHUB_CLIENT_SECRET\./);
});

test("readServeEnv: PUBLIC_URL is https with no path; plain http only for localhost", () => {
	assert.throws(() => readServeEnv({ ...secrets, PUBLIC_URL: "health.example.com" }), /full address/);
	assert.throws(() => readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com/mcp" }), /no path/);
	assert.throws(() => readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com/?a=1" }), /no path/);
	assert.throws(() => readServeEnv({ ...secrets, PUBLIC_URL: "http://health.example.com" }), /must be https/);
	assert.equal(readServeEnv({ ...secrets, PUBLIC_URL: "http://localhost:8788" }).publicUrl, "http://localhost:8788");
	assert.equal(readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com/" }).publicUrl, "https://health.example.com");
});

test("readServeEnv: the Worker's vars, with defaults for port, data and commit", () => {
	const s = readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com" });
	assert.equal(s.port, 8788);
	assert.equal(s.dataDir, "/data");
	assert.deepEqual(s.vars, { MCP_RESOURCE: "https://health.example.com/mcp", GIT_SHA: "unknown", ...secrets });
	const t = readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com", PORT: "9000", DATA_DIR: "/var/healthy", GIT_SHA: "abc1234" });
	assert.deepEqual([t.port, t.dataDir, t.vars.GIT_SHA], [9000, "/var/healthy", "abc1234"]);
	assert.throws(() => readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com", PORT: "http" }), /PORT/);
});

test("miniflareOptions: the bundle and its markdown modules, the bindings, storage and the public origin", () => {
	const serve = readServeEnv({ ...secrets, PUBLIC_URL: "https://health.example.com", DATA_DIR: "/data" });
	const config = { compatibilityDate: "2025-03-10", compatibilityFlags: ["nodejs_compat"], d1Binding: "DB", kvBinding: "OAUTH_KV", ratelimits: { AUTH_LIMIT: { simple: { limit: 20, period: 60 } } } };
	const o = miniflareOptions(serve, config, { distDir: "/app/dist", distFiles: ["index.js", "index.js.map", "abc-dashboard.md", "docker-config.json"], host: "0.0.0.0", port: 8788 });
	assert.deepEqual(o.modules, [
		{ type: "ESModule", path: path.join("/app/dist", "index.js") },
		{ type: "Text", path: path.join("/app/dist", "abc-dashboard.md") },
	]);
	assert.equal(o.upstream, "https://health.example.com");
	assert.equal(o.cf, false, "no request to Cloudflare at start");
	assert.equal(o.resourcePersistencePath, "/data");
	assert.deepEqual(Object.keys(o.d1Databases), ["DB"]);
	assert.deepEqual(Object.keys(o.kvNamespaces), ["OAUTH_KV"]);
	assert.equal(o.bindings.MCP_RESOURCE, "https://health.example.com/mcp");
	assert.equal(o.ratelimits, config.ratelimits);
});
