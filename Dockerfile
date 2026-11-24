# The Docker alternative to the Cloudflare deploy (docs/docker.md). The same Worker code runs on workerd, Cloudflare's
# open-source runtime, through Miniflare; D1 and KV are SQLite files in the /data volume.
#
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t healthy .
#
# config/allowed-users.json is built into the image (as it is into the Worker): edit it before building.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# Bundle the Worker exactly as a deploy would, then check the allowlist and write dist/docker-config.json.
RUN npx wrangler deploy --dry-run --outdir dist && node scripts/docker.mjs prepare
# The runtime needs only Miniflare (and the workerd binary it runs), at the version package-lock.json pins.
RUN mkdir /runtime && cd /runtime && echo '{"private":true}' > package.json \
	&& npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock \
		"miniflare@$(node -p 'require("/app/package-lock.json").packages["node_modules/miniflare"].version')"

FROM node:22-bookworm-slim
# workerd needs the system CA certificates for its https calls (GitHub, Google, USDA, Open Food Facts).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG GIT_SHA=unknown
ENV NODE_ENV=production DATA_DIR=/data PORT=8788 GIT_SHA=$GIT_SHA
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/docker.mjs ./scripts/docker.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8788
# Healthy means: it answers, and it refuses a request without a token (the same check the Deploy workflow makes).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
	CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/mcp', { method: 'POST' }).then((r) => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"
CMD ["node", "scripts/docker.mjs", "serve"]
