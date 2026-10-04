# syntax=docker/dockerfile:1
# One container for hosts that run a single service (Render, Koyeb, Cloud Run): Caddy serves the
# web build on $PORT and proxies /api to the API beside it. The host terminates HTTPS.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/planning/package.json packages/planning/
COPY packages/database/package.json packages/database/

FROM manifests AS prod-deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@waypoint/api..."

FROM manifests AS build
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@waypoint/api..." --filter "@waypoint/web..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/planning packages/planning
COPY packages/database packages/database
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter "@waypoint/api..." build && pnpm --filter @waypoint/web build

FROM base AS runtime
RUN apk add --no-cache caddy
ENV NODE_ENV=production
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/planning/dist packages/planning/dist
COPY --from=build /app/packages/database/dist packages/database/dist
COPY packages/database/migrations packages/database/migrations
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile.single /etc/caddy/Caddyfile
COPY infra/single-start.sh /usr/local/bin/single-start
# Caddy keeps its state under the home directory, which the node user cannot write in /.
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
USER node
EXPOSE 8080
CMD ["sh", "/usr/local/bin/single-start"]
