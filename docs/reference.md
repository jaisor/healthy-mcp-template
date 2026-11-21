# Healthy: reference

Day-to-day use, troubleshooting, how it works and local development. Setup is in the [README](../README.md). Extra protection is in [docs/hardening.md](hardening.md).

## Day to day

- **Add or remove a person:** edit `config/allowed-users.json` (a `github_id` or a `google_email` per person), commit, run **Deploy** again. The allowlist is checked on every request, so once the deploy finishes the removed person is locked out immediately, even with a token they already hold.
- **Deploy on every push to `main`:** set the repository variable `DEPLOY_ENABLED` to `true`. Without it, pushes only run the tests, and you deploy by clicking **Run workflow**.
- **Update to newer code:** see [Updating your copy](#updating-your-copy), then run **Deploy**. Database changes are applied automatically.
- **Require approval for deploys:** create an environment named `production` (Settings, Environments) and add yourself as a required reviewer.
- **Remove everything:** nothing here deletes anything for you. In the Cloudflare dashboard delete the Worker, the D1 database and the KV namespace, then revoke the API token, delete the GitHub OAuth App and delete the Google OAuth client.

## Updating your copy

A copy made from the template does not stay linked to it, so pull in new versions yourself. Run these in your copy.

**The first time.** Git sees your copy and the template as unrelated, so every file that differs from the template's shows up as a conflict. That is expected:

```bash
git remote add template https://github.com/redSlug/healthy-mcp-template.git   # or your own template's address
git fetch template
git merge template/main --allow-unrelated-histories    # reports conflicts in several files
git checkout --theirs .                                # take the template's version of every conflicted file
git checkout --ours config/allowed-users.json          # but keep your own list of people
git add -A
git commit
```

If you edited any other file yourself, do not use `--theirs` for it: open it and merge by hand. Then push and run **Deploy**.

**Every time after that.** The histories are connected now, so it is simply:

```bash
git fetch template
git merge template/main
```

Changes you made are kept, and `config/allowed-users.json` is left alone unless the template changes it. Then push and run **Deploy**. Database changes arrive as new numbered files in `migrations/` and are applied for you.

## Troubleshooting

| You see | Cause and fix |
| --- | --- |
| Deploy stops with "Not set: ..." | A secret or variable from step 6 is missing or misspelled |
| "config/allowed-users.json is empty" | Put your GitHub username in `ALLOWED_GITHUB_USERS` or your Google email in `ALLOWED_GOOGLE_EMAILS` and run the script again (README step 6) |
| "WORKER_URL ... must start with the APP_NAME" | A `workers.dev` address has to be `https://<APP_NAME>.<your-subdomain>.workers.dev` (your subdomain is in README step 2) |
| "Cloudflare API ... failed" | The token lacks a permission or the account id is wrong (README step 2) |
| "This server is private" at sign-in | Your GitHub id or Google email is not in `config/allowed-users.json`, or the change is not deployed |
| Google says "redirect_uri_mismatch" | The OAuth client's authorized redirect URI is not exactly `WORKER_URL/callback/google` (README step 4) |
| Google says "Access blocked: app has not completed verification" | The consent screen is in Testing and you are not a test user: add yourself, or publish the app (README step 4) |
| "Your Google email is not verified" | Verify the email on your Google account, then sign in again |
| Your log is empty after signing in a new way | GitHub and Google sign-ins are separate accounts with separate logs. Sign in the way you did before |
| GitHub says "redirect_uri mismatch" | The OAuth App's callback is not exactly `WORKER_URL/callback` (README step 3) |
| The last deploy step fails | The server did not answer 401 to a request without a token within about 90 seconds; the log lists every attempt. Check `APP_NAME` and your subdomain, and the Worker in your Cloudflare dashboard |

## How it works

The assistant (Claude or your favorite LLM) decides which tool to call. The server knows who you are from the sign-in token, does all the logic and nutrition math, and reads and writes your data. GitHub Actions deploys the code and never serves requests.

Diagrams, one per page: [architecture](diagrams/architecture.md), [one tool call](diagrams/tool-call.md), [sign-in](diagrams/sign-in.md), [deploy](diagrams/deploy.md), [get_report](diagrams/get-report.md), [get_top_foods](diagrams/get-top-foods.md), [data model](diagrams/data-model-overview.md) and [all fields](diagrams/data-model-fields.md).

**Tools:** `search_foods`, `add_food`, `import_food`, `update_food`, `log_entries`, `update_log`, `archive_log`, `get_day`, `get_report`, `get_top_foods`, `log_workout`, `update_workout`, `archive_workout`, `get_daily_target_metrics`, `set_daily_target_metrics`, `archive_daily_target_metric`, `update_settings`, `get_server_version` (the deployed git commit, to check which code is running), `how_to_build_dashboard` (the dashboard recipe; source: [dashboard-build-instructions.md](dashboard-build-instructions.md)).

**Data:** the tables and every column are in the [data model diagrams](diagrams/data-model-overview.md) ([all fields](diagrams/data-model-fields.md)), and the schema is in [`migrations/`](../migrations/). What the diagrams do not say:

- **The server does the math.** `foods` hold nutrients per 100 g and `food_logs` hold only a food and grams, so every number is calculated. A fix with `update_food` changes every log of that food, past days included. A saved meal is a food too, and its nutrients are a snapshot: editing an ingredient later does not change the meal.
- **Planned logs.** `eaten=false` saves a log as planned, not yet eaten: it counts only in the day's planned totals, and `eaten=true` marks it eaten.
- **Nothing is deleted, and retries are safe.** Archiving sets `archived_at` and leaves the entry out of every day and total. Logging tools take a `client_request_id`, and a repeated id returns the first result.
- **Reports** (`get_report`, `get_top_foods`) are read-only and leave out archived and planned entries. A window with nothing logged is an error that says where the data starts. See [get_report](diagrams/get-report.md) and [get_top_foods](diagrams/get-top-foods.md).
- **JSON replies have one written shape.** `get_report`, `get_top_foods`, `get_day` and the target tools reply with JSON text (no `outputSchema`, no `structuredContent`). Each reply is checked against its schema in [`src/tools/replies.ts`](../src/tools/replies.ts) before it is sent, and the same schemas are written out in full into `how_to_build_dashboard`. Adding a field to a reply means adding it there.

**Security:** only people in `config/allowed-users.json` get in (by GitHub id, or by Google email that Google has verified), and that is re-checked on every request. Signing in with GitHub and with Google gives two separate accounts, even for the same person. The sign-in endpoints are rate limited per IP address (20 requests a minute, set in `wrangler.jsonc`). CI hands each secret only to the step that needs it and installs dependencies without running their install scripts. Every query is scoped to the signed-in user, and tests check that one user cannot see another's rows. The owner of the Cloudflare account can read everything in the database, so this is a personal tool, not a service for strangers.

## Develop locally

```bash
npm install
cp /dev/null .dev.vars   # then add the lines below
npx wrangler d1 migrations apply DB --local
npx wrangler dev         # http://localhost:8788
npm test
```

`.dev.vars` (gitignored) needs: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (a separate GitHub OAuth App whose callback is `http://localhost:8788/callback`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (a Google OAuth client with the redirect URI `http://localhost:8788/callback/google`; it can be the same client as production with both URIs added), `COOKIE_ENCRYPTION_KEY` and `USDA_API_KEY`. Your GitHub id or Google email must also be in `config/allowed-users.json`. Test the server without an assistant using `npx @modelcontextprotocol/inspector` and the URL `http://localhost:8788/mcp`.

Other commands: `npm run type-check` (generates the Cloudflare types first; they are not stored in the repo) and `npm run test:scripts` (tests the provisioning script).

## Where things are

- `src/data/`: the only place with SQL; every function takes a `userId`
- `src/services/`: the rules behind each tool; `src/nutrition.ts`: the math (pure functions)
- `src/tools/`: MCP tool registration; `src/auth-handler.ts`: sign-in with GitHub or Google
- `src/foodapis/`: USDA and Open Food Facts clients
- `docs/`: reference, data-model diagrams, hardening; `migrations/`: database schema; `config/allowed-users.json`: who may sign in
- `scripts/provision.mjs`: creates the D1 database and KV namespace if missing (used by the Deploy workflow)
- `.github/workflows/`: `ci.yml` (tests) and `deploy.yml` (the only way anything is deployed)
