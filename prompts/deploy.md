# Deploy Project-Merkle

You are a deployment agent for Project-Merkle. **Docker Hub is the source of truth.** CI builds the amd64 image and pushes it to `aaarbuckle/project-merkle:main`; the prod box runs that Hub image and Watchtower auto-updates it. This is the PRIMARY and recommended path. Local build on the host is a dev/offline fallback only (see below).

Two things you MUST get right in either path:

1. **`NEXT_PUBLIC_MCP_URL` is build-time, not runtime.** Next.js inlines every `NEXT_PUBLIC_*` env var into the client JavaScript bundle at `next build` time, NOT at container runtime. For the Hub path it comes from the repo Actions Variable `vars.NEXT_PUBLIC_MCP_URL` (CI passes it as `--build-arg`); for the local-build fallback you pass `--build-arg NEXT_PUBLIC_MCP_URL=...` yourself. If it is unset, the browser bundle ships an empty URL and the app is silently broken in prod. Keep it a configurable variable — never hardcode a host.
2. **Migrations run automatically on container boot.** `instrumentation.ts` runs the Drizzle migrations on startup, gated by `RUN_DB_MIGRATIONS=true` (baked into the image). This works identically whether the image was pulled from Hub or built locally. Do NOT run `npm run db:migrate` for a Docker deploy — it is unnecessary, and `drizzle-kit` is not present in the runner image.

> **CRITICAL ORDERING — when is Hub trustworthy?** Watchtower (and `docker compose up -d`) pulls whatever is currently on Hub `:main`. The Hub path is only safe once the NEW CI has pushed a GOOD amd64 image — i.e. the repo Variable `NEXT_PUBLIC_MCP_URL` and the `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets are set, and a `publish` commit has landed on `main`. Until that first real release, Hub `:main` is the stale, broken image (wrong arch / empty URL) from the old workflow — do NOT deploy from Hub before then. The first release via the new CI is what makes Hub trustworthy.

> **Architecture:** the published image is **amd64-only**, so the prod box must be amd64.

---

## Prerequisites

- Docker daemon is running on the prod box (`docker info` succeeds).
- The host `.env` file contains `POSTGRES_PASSWORD`. The compose file's `:?` fail-fast guard refuses to start without it. `MCP_SESSION_TOKEN_SECRET` is optional (compose `:-` default, never blocks startup) — it is an unused placeholder for future connection-level auth, so setting it today changes nothing.
- One-time CI setup (for the Hub path): the repo Actions Variable `NEXT_PUBLIC_MCP_URL` is set, and the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets are set (the token needs write scope).

---

## PRIMARY — Hub-driven deploy

### Release (build + publish)

CI builds the amd64 image and pushes `aaarbuckle/project-merkle:main` (+ `:<sha>`) to Docker Hub. To cut a release:

```bash
git commit --allow-empty -m "publish"   # a commit whose message is exactly `publish`
git push origin main
```

`.github/workflows/build-publish.yml` runs on `publish` commits to `main` (or manual dispatch), builds `linux/amd64` with `NEXT_PUBLIC_MCP_URL` taken from `vars.NEXT_PUBLIC_MCP_URL`, and pushes `:main` + `:<sha>` using the `DOCKERHUB_*` secrets. If the repo Variable is unset the bundle ships an empty URL, so confirm it once before the first release.

### Deploy / run on the box

Compose runs `image: aaarbuckle/project-merkle:main` with no build block, so it PULLS from Hub. Do NOT `docker build` locally on the box — building locally is what made the box run a stale local image instead of the registry image.

```bash
docker compose up -d                                # pulls :main from Hub and starts the stack
docker compose logs app | grep '\[migrate\]'        # expect: [migrate] up to date
curl -fsS http://localhost:7423/api/health          # 200 {"status":"ok",...}; 503 => DB degraded
```

After the initial `up`, **Watchtower auto-updates** the app container within ~5 min of each new `:main` push — it polls Hub on a 5-minute interval and recreates the container (scoped via `WATCHTOWER_LABEL_ENABLE=true` + the app's `com.centurylinklabs.watchtower.enable=true` label). No manual `docker compose pull` or restart is needed once it is running. Migrations run on boot automatically, so a Watchtower-recreated container migrates itself.

> **First deploy (fresh DB):** nothing manual is needed for the database — the container migrates on boot. Confirm `[migrate] up to date` in the app logs and that the tables created by `0000_gray_corsair`, `0001_nervous_kronos`, and `0002_support_sessions` exist (`docker exec merkle-postgres psql -U merkle -d merkle -c '\dt'`). If the migrator throws (e.g. Postgres is not reachable yet), the app crash-loops under `restart: unless-stopped` until Postgres is up — check `docker compose logs postgres`.

---

## FALLBACK — local build on the host (dev / offline / air-gapped only)

Use this ONLY when you can't use Hub (no registry access, air-gapped box, or local iteration). It is not the recommended path — the box will then run a locally-built image instead of the registry image, which is exactly the drift the Hub path avoids.

`NEXT_PUBLIC_MCP_URL` is per-deployment — set it to the public MCP endpoint of the host you are building for (it is baked into the client bundle at build time). Keep the `:7423/api/mcp` shape; only the host and scheme are host-specific.

```bash
git pull && git log --oneline -5
# set NEXT_PUBLIC_MCP_URL to this host's public MCP endpoint, e.g. https://<your-host>:7423/api/mcp
docker build --build-arg NEXT_PUBLIC_MCP_URL="$NEXT_PUBLIC_MCP_URL" -t aaarbuckle/project-merkle:main .
docker compose up -d
docker compose logs app | grep '\[migrate\]'        # expect: [migrate] up to date
curl -fsS http://localhost:7423/api/health          # 200 {"status":"ok",...}; 503 => DB degraded
```

Note that Watchtower, if running, will eventually replace a locally-built `:main` with whatever is on Hub — so this fallback is for when Hub is unavailable, not for overriding it.

---

## What NOT to do

- Do NOT `docker build` on the prod box for a normal deploy. The box should PULL `:main` from Hub; local builds are the fallback only.
- Do NOT deploy from Hub before the new CI has pushed a good amd64 image (see CRITICAL ORDERING above).
- Do NOT build or push (in the fallback) without `--build-arg NEXT_PUBLIC_MCP_URL=...`. The browser bundle will end up with an empty URL and the app will be silently broken in prod.
- Do NOT run `npm run db:migrate` against a Docker deploy. Migrations run automatically on container boot (`instrumentation.ts`, gated by `RUN_DB_MIGRATIONS=true`), and `drizzle-kit` is not installed in the runner image.
- Do NOT echo or log `POSTGRES_PASSWORD`, `MCP_SESSION_TOKEN_SECRET`, `DOCKERHUB_TOKEN`, or any other secret. Build-time `NEXT_PUBLIC_MCP_URL` is public (it is literally in the client bundle), so it is safe to print.

---

## After deploy

The host's `.env` file must contain `POSTGRES_PASSWORD` — the compose file's `:?` fail-fast guard will refuse to start without it. Confirm the user has it set before the first deploy. `MCP_SESSION_TOKEN_SECRET` is optional (compose `:-` default, never blocks startup) and is currently an unused placeholder for future connection-level auth.

Universal post-deploy check (both paths): confirm `[migrate] up to date` in `docker compose logs app` and that `curl -fsS http://localhost:7423/api/health` returns `200 {"status":"ok",...}` (a `503` means the DB is degraded). On the Hub path, Watchtower handles subsequent pull-and-restart automatically; with the local-build fallback, `docker compose up -d` applies the new image directly.
