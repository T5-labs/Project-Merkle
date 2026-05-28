# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────
# Stage 1: deps — install production + dev dependencies
# ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ──────────────────────────────────────────────────────────────
# Stage 2: builder — compile the Next.js standalone bundle
# ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# lib/db/index.ts evaluates DATABASE_URL at module load time and
# throws if it is missing. Provide a placeholder so the build
# succeeds; the real value is injected at runtime via docker-compose.
ENV DATABASE_URL=postgresql://placeholder@localhost:5432/db
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules

ARG NEXT_PUBLIC_MCP_URL
ENV NEXT_PUBLIC_MCP_URL=${NEXT_PUBLIC_MCP_URL}

COPY . .

RUN npm run build

# ──────────────────────────────────────────────────────────────
# Stage 3: runner — minimal runtime image, no build tools
# ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Runtime env vars — overridden by docker-compose at container start.
# These are stubs only; set real values in docker-compose.yml or via -e flags.
ENV DATABASE_URL=""
ENV NEXT_PUBLIC_MCP_URL=""
ENV MCP_SESSION_TOKEN_SECRET=""

# Bind the standalone server to all interfaces inside the container so
# Docker bridge-network traffic is not silently dropped.
ENV HOSTNAME=0.0.0.0
# Default port — overridable at runtime via the PORT env var.
ENV PORT=7423

# Run as the built-in non-root `node` user (uid 1000) that ships with
# the node:alpine images — no custom user creation needed.
USER node

# Copy only the standalone server output and the static assets.
# The standalone bundle ships its own tree-shaken node_modules — no
# separate node_modules or package.json copy needed.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# public/ does not currently exist in this project.
# Uncomment the line below if public/ is added in a future phase:
# COPY --from=builder --chown=node:node /app/public ./public

EXPOSE 7423

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 7423) + '/', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
