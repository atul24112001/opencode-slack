# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Build deps for native modules (better-sqlite3 falls back to source build
# if no prebuilt binary matches the runtime).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime

# git: opencode shells out to it, and the entrypoint clones repos.
# opencode-ai: the CLI the bot spawns.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g opencode-ai \
    && npm cache clean --force

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    OPENCODE_BIN=/usr/local/bin/opencode \
    WORKSPACE_DIR=/workspace

RUN mkdir -p /data /workspace && chown node:node /data /workspace

USER node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
