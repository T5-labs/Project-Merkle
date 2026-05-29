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
ENV MCP_SESSION_TOKEN_SECRET=""

# Auto-apply pending Drizzle migrations on boot (instrumentation.ts).
# Overridable: set RUN_DB_MIGRATIONS=false to disable migrating on start.
ENV RUN_DB_MIGRATIONS=true

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

# Drizzle migration files (.sql + meta/) are NOT part of the standalone
# bundle. The boot-time migrator (instrumentation.ts) reads them from
# `drizzle` relative to the WORKDIR (process.cwd()), so copy them next to
# server.js at the app root.
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

# public/ does not currently exist in this project.
# Uncomment the line below if public/ is added in a future phase:
# COPY --from=builder --chown=node:node /app/public ./public

EXPOSE 7423

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 7423) + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
