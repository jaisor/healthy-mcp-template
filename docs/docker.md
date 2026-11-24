# Run it with Docker

An alternative to the Cloudflare setup in the README: run the server on any machine with Docker, and keep the data in a file on that machine.

It is the same code. The Worker is bundled exactly as for a deploy and runs on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime, through Miniflare. The D1 database and the KV storage (sign-in tokens) are SQLite files in the `/data` volume. Nothing talks to Cloudflare.

## What you need

- A machine with Docker and Docker Compose.
- To use it from claude.ai: a domain name pointing at that machine, with ports 80 and 443 open. claude.ai only connects to `https` addresses that it can reach over the internet. To try it on your own machine first, use `http://localhost:8788`, which works with clients running on the same machine (for example Claude Code or the MCP Inspector).
- The GitHub OAuth App, Google OAuth client and USDA key from README steps 3 to 5. Use your Docker address wherever the README says `https://healthy.<your subdomain>.workers.dev`. The callback URLs are `PUBLIC_URL/callback` (GitHub) and `PUBLIC_URL/callback/google` (Google).

## Set up

1. **Who may sign in.** Edit [`config/allowed-users.json`](../config/allowed-users.json) as in the README (a `github_id` or a `google_email` per person). It is built into the image, and the build stops if it is empty.
2. **Settings.** Copy [`.env.example`](../.env.example) to `.env` and fill it in. `.env` is gitignored: never commit it.
3. **Start.**

   On a server, with HTTPS (Caddy gets and renews a certificate for `PUBLIC_URL`):

   ```bash
   GIT_SHA=$(git rev-parse HEAD) docker compose --profile https up -d --build
   ```

   On your own machine, with `PUBLIC_URL=http://localhost:8788`:

   ```bash
   docker compose up -d --build
   ```

4. **Check.** `docker compose ps` shows the app as `healthy` once it answers and refuses a request without a token. `docker compose logs healthy` shows the connector URL.
5. **Connect.** Add `PUBLIC_URL/mcp` as a connector, as in the README's "Use your MCP".

`GIT_SHA` is optional; it is what `get_server_version` reports (`unknown` without it).

## Day to day

- **Add or remove a person:** edit `config/allowed-users.json` and run the start command again (it rebuilds). The allowlist is checked on every request, so a removed person is locked out as soon as the new container is up.
- **Update to newer code:** pull it (see "Updating your copy" in [reference.md](reference.md)) and run the start command again. New migrations are applied when the container starts, before it serves anything. Each migration is applied completely or not at all.
- **Back up:** everything is in the `healthy-data` volume. Stop the app first so the SQLite files are consistent:

  ```bash
  docker compose stop healthy
  docker run --rm -v healthy-mcp-template_healthy-data:/data -v "$PWD":/backup busybox tar czf /backup/healthy-data.tgz -C /data .
  docker compose start healthy
  ```

  The volume name starts with the project folder's name; `docker volume ls` shows it.
- **Remove everything:** `docker compose --profile https down -v` deletes the containers and both volumes (your data and Caddy's certificates). Then delete the GitHub OAuth App and the Google OAuth client.

## Without Caddy

Any HTTPS reverse proxy or tunnel works (nginx, Traefik, Cloudflare Tunnel, Tailscale Funnel), if it:

- forwards to port 8788 of the `healthy` container, and keeps the `Host` header;
- sets the `CF-Connecting-IP` header to the client's address, replacing any value the client sent (Cloudflare Tunnel does this by itself). The sign-in endpoints are rate limited per address with it. A request without it is refused with 400, and a client that can reach port 8788 directly can choose its own;
- does not serve `/cdn-cgi/*` (Miniflare's internal routes, which need a secret anyway).

Never expose port 8788 to the internet directly. `compose.yaml` publishes it on `127.0.0.1` only.

## How it differs from Cloudflare

- **Your machine holds the data.** Whoever can read the `healthy-data` volume can read everything in it, as the Cloudflare account owner can on Cloudflare. Back it up yourself.
- **One instance.** The data is local files, so run one container per volume. It does not scale out, which is fine for a personal tool.
- **The image:** two stages. The first installs the dependencies, bundles the Worker with `wrangler deploy --dry-run`, and runs `node scripts/docker.mjs prepare`: it checks the allowlist and writes `dist/docker-config.json` (the settings from `wrangler.jsonc`, and the migrations split into statements). The second holds only Miniflare, the bundle and [`scripts/docker.mjs`](../scripts/docker.mjs), and runs as a non-root user.
- **At start,** `node scripts/docker.mjs serve` checks the settings (it names everything missing), applies new migrations on a private port, and then serves on port 8788. It records applied migrations in `d1_migrations`, the table wrangler uses.
- **request.url** is always `PUBLIC_URL`, whatever address the proxy used, so OAuth redirect addresses and the token audience are right.
