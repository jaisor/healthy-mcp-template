# Healthy MCP template

A private health helper template to use with your favorite AI assistant that supports MCP servers. Say what you ate, drank or did; the assistant calls this server; the server stores it and does all the nutrition math. It is built to be **your own copy**: you run it on your own Cloudflare account and your data stays there.

> **This is a template.** Click **Use this template** at the top of the GitHub page (or [use it directly](https://github.com/redSlug/healthy-mcp-template/generate)) to get your own copy of the code in your own GitHub account, then follow the steps below. Nothing in it belongs to anyone's account: no ids, names or URLs are stored in the repo, the list of people who may sign in starts empty, and every key is yours and lives in your GitHub secrets.

## Set up your MCP

You need a [GitHub](https://github.com/signup) account, a [Cloudflare](https://dash.cloudflare.com/sign-up) account and a [Google Cloud](https://console.cloud.google.com/) project (for Google sign-in). The free plans are enough to start (check each provider's current limits).

Throughout, **OWNER/REPO** means your copy of this repo, for example `redSlug/healthy-mcp-template`.

### 1. Use this template

Click **Use this template** > **Create a new repository** (you can make it private). Or clone or fork this repo.

### 2. Cloudflare: account id, subdomain and API token

1. [Sign up](https://dash.cloudflare.com/sign-up) and create an account (best practice: a separate account for each MCP server you run), then open Workers & Pages. Pick a `workers.dev` subdomain if asked, and note it and your **Account ID** (on the right).
2. Under My Profile, API Tokens, create a custom token for your account only, with **Edit** permission for Workers Scripts, D1 and Workers KV Storage, and **Read** for Account Settings.

### 3. GitHub OAuth App (sign in with GitHub)

GitHub cannot create these automatically, so do it once by hand: [github.com/settings/applications/new](https://github.com/settings/applications/new).

| Field | Value |
| --- | --- |
| Application name | Anything. People see it on the sign-in screen |
| Homepage URL | `https://healthy.<your subdomain>.workers.dev` (your subdomain is from step 2; use your own app name instead of `healthy` if you change `APP_NAME` in the script) |
| Authorization callback URL | That same address followed by `/callback` |

Leave the checkboxes **Allow wildcard matching**, **Enable Device Flow** and **Expire user access tokens** unchecked: the server uses one exact callback address and the normal browser sign-in, and it uses the GitHub token once to read who signed in and never stores it.

Click **Register application**, then **Generate a new client secret**. Copy the **Client ID** and the **client secret**.

### 4. Google OAuth client (sign in with Google)

People can sign in with GitHub or Google; the sign-in page always shows both. In the [Google Cloud console](https://console.cloud.google.com/):

1. Pick or create a project. Under **APIs & Services, OAuth consent screen**, set it up as **External** with your app name and your email. Add only the scopes `openid` and `email` (they need no review by Google). While the app is in **Testing**, add each person who will sign in with Google as a test user, or click **Publish app**.
2. Under **APIs & Services, Credentials**, choose **Create credentials, OAuth client ID**, type **Web application**.
3. Under **Authorized redirect URIs**, add `https://healthy.<your subdomain>.workers.dev/callback/google` (your app name instead of `healthy` if you changed it).
4. Click **Create** and copy the **Client ID** and **Client secret**.

The server reads only the account id and the verified email from Google, and keeps nothing else.

### 5. USDA food database key

Get a free key at [fdc.nal.usda.gov/api-key.html](https://fdc.nal.usda.gov/api-key.html). It is emailed to you.

### 6. Put the keys into your GitHub repo

Fill in the values at the top of [`scripts/sample_script.sh`](scripts/sample_script.sh), including who may sign in (GitHub usernames, Google emails, or both), and run it with `bash scripts/sample_script.sh`. It also prints your server address. Then discard your edits so the keys are never committed.

<details>
<summary>Or add them by hand in the GitHub website</summary>

Who may sign in: edit [`config/allowed-users.json`](config/allowed-users.json) to a list like `[{ "github_id": 12345678, "login": "your-login" }, { "google_email": "you@gmail.com" }]`. A GitHub entry uses the numeric id: find it at `https://api.github.com/users/` plus the username (for example [api.github.com/users/redSlug](https://api.github.com/users/redSlug)), under `id`. A Google entry uses the email of the Google account (only emails Google has verified can sign in). Commit it.

Secrets, at `https://github.com/OWNER/REPO/settings/secrets/actions` (**New repository secret**):

| Secret name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | The account id from step 2 |
| `OAUTH_GITHUB_CLIENT_ID` | The OAuth App's Client ID (step 3) |
| `OAUTH_GITHUB_CLIENT_SECRET` | The OAuth App's client secret (step 3) |
| `OAUTH_GOOGLE_CLIENT_ID` | The Google OAuth client's Client ID (step 4) |
| `OAUTH_GOOGLE_CLIENT_SECRET` | The Google OAuth client's Client secret (step 4) |
| `COOKIE_ENCRYPTION_KEY` | A long random string of 32+ characters, unique to this app. Make one with `openssl rand -hex 32`, or with your password manager's generator |
| `USDA_API_KEY` | The USDA key (step 5) |

Variables, at `https://github.com/OWNER/REPO/settings/variables/actions` (**New repository variable**, not secrets):

| Variable name | Value |
| --- | --- |
| `APP_NAME` | Your app name (`healthy` unless you changed it) |
| `WORKER_URL` | `https://<app name>.<your subdomain>.workers.dev` |
</details>

### 7. Deploy

Go to `https://github.com/OWNER/REPO/actions/workflows/deploy.yml`, click **Run workflow**, then **Run workflow** again. When it turns green (a minute or two), your connector address is `WORKER_URL/mcp`.

<details>
<summary>What the workflow does</summary>

1. runs the tests;
2. checks that every key and setting above is present;
3. **creates your D1 database and KV storage in your Cloudflare account** (only what is missing);
4. sets up the database tables;
5. deploys the server together with its secrets;
6. waits for the server to come online (a brand-new one can take a few seconds) and checks that it refuses requests without a token.
</details>

## Use your MCP

Add `WORKER_URL/mcp` (it must end in `/mcp`) as a remote MCP server in your assistant, and sign in with GitHub or Google when asked. Then try: "Log 150 grams of cottage cheese for lunch", "I drank a glass of water", or "I ran for 30 minutes".

<details>
<summary>Example: Claude</summary>

1. Open [claude.ai/settings/connectors](https://claude.ai/settings/connectors) and choose **Add custom connector**.
2. Enter `WORKER_URL/mcp`. Choose **Sign in now**, and let the OAuth client **register automatically**. Leave headers empty.
3. On the sign-in screen choose **Continue with GitHub** or **Continue with Google**, and sign in.
4. In a new chat, turn the connector on.
</details>

More: [day to day, updating your copy, troubleshooting, how it works and local development](docs/reference.md).

## License

[MIT](LICENSE)
