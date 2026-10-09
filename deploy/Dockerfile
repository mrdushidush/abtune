# syntax=docker/dockerfile:1
# Debian (glibc), not Alpine: DuckDB and resvg ship glibc prebuilt binaries (ADR-0001).
FROM node:24-bookworm-slim AS base
ENV CI=true
RUN npm install -g pnpm@10.34.6 && npm cache clean --force
WORKDIR /app

# Manifests first so dependency layers cache across source edits.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/ai/package.json packages/ai/
COPY packages/bank/package.json packages/bank/
COPY packages/cli/package.json packages/cli/
COPY packages/catalog/package.json packages/catalog/
COPY packages/eval/package.json packages/eval/
COPY packages/connectors/package.json packages/connectors/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/

FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @abtune/web build

FROM manifests AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
RUN pnpm install --frozen-lockfile --prod --filter "@abtune/web..." --filter "@abtune/cli..."
# Node 24 runs the TypeScript sources directly (type stripping); no server bundle step.
COPY packages/engine/src packages/engine/src
# The AI layer's prompts are versioned files read at runtime (HANDOFF §10.5).
COPY packages/ai/src packages/ai/src
COPY packages/ai/prompts packages/ai/prompts
COPY packages/bank/src packages/bank/src
COPY packages/catalog/src packages/catalog/src
COPY packages/connectors/src packages/connectors/src
COPY packages/eval/src packages/eval/src
COPY packages/cli/src packages/cli/src
COPY apps/web/src/server apps/web/src/server
# The client/server API contract (the server imports a constant from it).
COPY apps/web/src/api-types.ts apps/web/src/api-types.ts
COPY data/questions data/questions
COPY data/personas data/personas
COPY --from=build /app/apps/web/dist apps/web/dist
# Catalogs are mounted here (compose) and written by `abtune catalog fetch`; Spotify connections
# (encrypted) are kept in data/spotify, and a public instance's usage counters in data/stats.
RUN mkdir -p data/catalog data/spotify data/stats && chown node:node data/catalog data/spotify data/stats
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/src/server/main.ts"]
