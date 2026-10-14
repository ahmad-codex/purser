# Purser server: MCP endpoint, approvals API and the console, in one image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY apps/console/package.json apps/console/
RUN npm ci --no-audit --no-fund

FROM deps AS console
COPY tsconfig.base.json ./
COPY apps/console apps/console
RUN npm run build -w @purser/console

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PURSER_HOST=0.0.0.0 \
    PURSER_PORT=8787 \
    PURSER_CONSOLE_DIR=/app/apps/console/dist \
    PURSER_DATA_DIR=/data
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.base.json ./
COPY packages packages
COPY scripts/demo.ts scripts/demo.ts
COPY --from=console /app/apps/console/dist apps/console/dist
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node_modules/.bin/tsx", "packages/server/src/index.ts"]
