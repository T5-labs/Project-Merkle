# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────
# Stage 1: deps — install production + dev dependencies
# ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ──────────────────────────────────────────────────────────────
# Stage 2: builder — compile the Next.js standalone bundle
# ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

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
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Runtime env vars — overridden by docker-compose at container start.
# These are stubs only; set real values in docker-compose.yml or via -e flags.
ENV DATABASE_URL=""
ENV NEXT_PUBLIC_MCP_URL=""

# Run as the built-in non-root `node` user (uid 1000) that ships with
# the node:alpine images — no custom user creation needed.
USER node

# Copy only the standalone server output and the static assets.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# public/ does not currently exist in this project.
# Uncomment the line below if public/ is added in a future phase:
# COPY --from=builder --chown=node:node /app/public ./public

# Copy drizzle migrations so `npm run db:migrate` can be run inside
# the container if needed (e.g. docker compose exec app npm run db:migrate).
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3000

CMD ["node", "server.js"]
