# syntax=docker/dockerfile:1.7
# Stock NanoClaw plus the workspace's runtime closure, channel and skills.
# build.ts supplies the verified upstream source and builds its stock base.
ARG NANOCLAW_AGENT_IMAGE=nanoclaw-agent:unconfigured
FROM ${NANOCLAW_AGENT_IMAGE} AS builder

USER root
# better-sqlite3's native build needs a compiler, make and Python. They are
# pinned to the versions Debian bookworm, the pinned base's release, ships, so
# a changed toolchain fails here instead of compiling the addon differently.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    g++=4:12.2.0-3 make=4.3-4.1 python3=3.11.2-1+b1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=nanoclaw-source . /opt/moltzap/nanoclaw/app
COPY --from=social-harness-channel sharness.ts /opt/moltzap/nanoclaw/channel/sharness.ts
COPY nanoclaw-v2.3.0.patch prepare.ts pnpm-lock.yaml /opt/moltzap/nanoclaw/

# The install takes every dependency, with its integrity hash, from the
# committed pnpm-lock.yaml that `build.ts lock` resolved for this patched
# and prepared tree, and fails if the tree no longer matches it.
COPY --from=social-harness-workspace . /opt/social-harness/workspace/
WORKDIR /opt/moltzap/nanoclaw/app
RUN git apply --check /opt/moltzap/nanoclaw/nanoclaw-v2.3.0.patch \
  && git apply /opt/moltzap/nanoclaw/nanoclaw-v2.3.0.patch \
  && node /opt/moltzap/nanoclaw/prepare.ts \
    /opt/moltzap/nanoclaw/app \
    /opt/moltzap/nanoclaw/channel/sharness.ts \
  && cp /opt/moltzap/nanoclaw/pnpm-lock.yaml pnpm-lock.yaml \
  && HUSKY=0 pnpm install --frozen-lockfile \
  && mkdir -p node_modules/@moltzap node_modules/@modelcontextprotocol \
  && ln -s /opt/social-harness/workspace/node_modules/@moltzap/client node_modules/@moltzap/client \
  && ln -s /opt/social-harness/workspace/node_modules/effect node_modules/effect \
  && ln -s /opt/social-harness/workspace/node_modules/@modelcontextprotocol/client node_modules/@modelcontextprotocol/client \
  && pnpm run build \
  && mkdir -p /app/node_modules/@moltzap \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/@moltzap/client /app/node_modules/@moltzap/client \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/effect /app/node_modules/effect \
  && ln -s /app/node_modules container/agent-runner/node_modules \
  && /app/node_modules/.bin/tsc --noEmit -p container/agent-runner/tsconfig.json \
  && node --input-type=module --eval \
    'const { default: Database } = await import("better-sqlite3"); const database = new Database(":memory:"); database.close()' \
  && rm -rf /root/.cache /root/.local/share/pnpm/store

FROM ${NANOCLAW_AGENT_IMAGE}

USER root
ARG NANOCLAW_SOURCE_REVISION
ARG NANOCLAW_SOURCE_ARCHIVE_SHA256
LABEL org.social-harness.nanoclaw-source-revision="${NANOCLAW_SOURCE_REVISION}"
LABEL org.social-harness.nanoclaw-source-archive-sha256="${NANOCLAW_SOURCE_ARCHIVE_SHA256}"

COPY --from=builder /opt/social-harness/workspace /opt/social-harness/workspace
COPY --from=builder /opt/moltzap/nanoclaw/app /opt/moltzap/nanoclaw/app
# NanoClaw links every directory under container/skills into each agent
# group's ~/.claude/skills, so this adds the skills the Client ships without
# changing NanoClaw's source.
COPY --from=social-harness-workspace node_modules/@moltzap/client/skills/ /opt/moltzap/nanoclaw/app/container/skills/
COPY entrypoint.ts /opt/moltzap/nanoclaw/entrypoint.ts
COPY gateway.ts preload.ts process-driver.ts provision.ts /opt/moltzap/nanoclaw/

# Bun resolves the mounted runner from /app, while Node resolves the host from
# its extracted tree. The links give both processes the same patched packages.
RUN mkdir -p /var/lib/moltzap/nanoclaw \
  && mkdir -p /app/node_modules/@moltzap \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/@moltzap/client /app/node_modules/@moltzap/client \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules/effect /app/node_modules/effect \
  && ln -s /opt/moltzap/nanoclaw/app/node_modules /opt/moltzap/node_modules \
  && ln -s /opt/moltzap/nanoclaw/app/container/agent-runner/src /app/src \
  && ln -s /opt/moltzap/nanoclaw/app/container/skills /app/skills \
  && ln -s /opt/moltzap/nanoclaw/app/container/CLAUDE.md /app/CLAUDE.md \
  && ln -s /var/lib/moltzap/nanoclaw/current-session-context /app/.nanoclaw-session.json \
  && rmdir /workspace/group /workspace/extra /workspace \
  && ln -s /var/lib/moltzap/nanoclaw/current-workspace /workspace \
  && chown -R node:node /var/lib/moltzap/nanoclaw

ENV NODE_ENV=production
WORKDIR /var/lib/moltzap/nanoclaw
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/moltzap/nanoclaw/entrypoint.ts"]
