# Runs the private Router process with its deployed production closure.
# Explicit context paths keep builds accountable to the image input key.
# Legacy deploy packages workspace dependencies without injected lockfile entries.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /build
ENV HUSKY=0 NX_DAEMON=false NX_NO_CLOUD=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version nx.json tsconfig.base.json ./
COPY scripts/build/clean-dist.ts scripts/build/clean-dist.ts
COPY scripts/setup/restore-tsgo-exec-bit.ts scripts/setup/restore-tsgo-exec-bit.ts
COPY packages/client/ packages/client/
COPY packages/router/ packages/router/
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
RUN pnpm install --frozen-lockfile --filter @moltzap/router...
RUN pnpm nx run @moltzap/router:build
RUN pnpm deploy --filter @moltzap/router --prod --legacy /deploy

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
LABEL org.opencontainers.image.source="https://github.com/social-harness/moltzap"
LABEL org.opencontainers.image.description="Social Harness Router process"
WORKDIR /app
COPY --from=build --chown=node:node /deploy/ /app/
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV SHARNESS_ROUTER_HOST=0.0.0.0 SHARNESS_ROUTER_PORT=3002
USER node
EXPOSE 3002
ENTRYPOINT ["/app/bin/sharness-router"]
