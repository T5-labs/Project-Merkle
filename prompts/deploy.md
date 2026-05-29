# Deploy Project-Merkle

You are a deployment agent for Project-Merkle. There are two deploy models. Pick one:

- **PRIMARY (recommended):** build the Docker image locally on the prod host with the correct build-time env vars baked in, then `docker compose up -d`. No Docker Hub, no Watchtower. This is what works reliably and is what the rest of this prompt optimizes for.
- **SECONDARY (optional):** push the image to Docker Hub and let Watchtower roll the prod container. This path has a sharp edge — org CI can clobber your image — so only use it if you specifically want Hub-based updates, and read the warning in that section.

Two things you MUST get right in either model:

1. **`NEXT_PUBLIC_MCP_URL` is build-time, not runtime.** Next.js inlines every `NEXT_PUBLIC_*` env var into the client JavaScript bundle at `next build` time, NOT at container runtime. The public MCP URL must be passed as `--build-arg NEXT_PUBLIC_MCP_URL=...` during `docker build`. If you skip it, the browser bundle ships an empty URL and the app is silently broken in prod.
2. **Migrations run automatically on container boot.** `instrumentation.ts` runs the Drizzle migrations on startup, gated by `RUN_DB_MIGRATIONS=true` (baked into the image). Do NOT run `npm run db:migrate` for a Docker deploy — it is unnecessary, and `drizzle-kit` is not present in the runner image.

---

## Prerequisites

Confirm these are true on the machine where you will run the build:

- Docker daemon is running (`docker info` succeeds).
- The Project-Merkle repo is cloned and you are on the commit you want to deploy (verify with `git log --oneline -5`).
- The host `.env` file contains `POSTGRES_PASSWORD`. The compose file's `:?` fail-fast guard refuses to start without it. `MCP_SESSION_TOKEN_SECRET` is optional (compose `:-` default, never blocks startup) — it is an unused placeholder for future connection-level auth, so setting it today changes nothing.

Secondary path only:

- You are logged in to Docker Hub (`docker login` if not — credentials are the user's). This is NOT needed for the primary local-build path.

---

## PRIMARY procedure — local build on the prod host

This is the path that worked. Run it on the prod host itself.

`NEXT_PUBLIC_MCP_URL` is per-deployment — set it to the public MCP endpoint of the host you are building for (it is baked into the client bundle at build time). Keep the `:7423/api/mcp` shape; only the host and scheme are host-specific.

```bash
git pull && git log --oneline -5
# set NEXT_PUBLIC_MCP_URL to this host's public MCP endpoint, e.g. https://your-host:7423/api/mcp
docker build --build-arg NEXT_PUBLIC_MCP_URL="$NEXT_PUBLIC_MCP_URL" -t aaarbuckle/project-merkle:main .
docker compose up -d
docker compose logs app | grep '\[migrate\]'        # expect: [migrate] up to date
docker exec merkle-postgres psql -U merkle -d merkle -c '\dt'
curl -fsS http://localhost:7423/api/health          # 200 {"status":"ok",...}; 503 => DB degraded
```

> **First deploy (fresh DB):** nothing manual is needed for the database — the container migrates on boot. Confirm `[migrate] up to date` in the app logs and that `\dt` lists the tables created by `0000_gray_corsair`, `0001_nervous_kronos`, and `0002_support_sessions`. If the migrator throws (e.g. Postgres is not reachable yet), the app crash-loops under `restart: unless-stopped` until Postgres is up — check `docker compose logs postgres`.

---

## SECONDARY (optional) — Docker Hub + Watchtower

> **WARNING — org CI can clobber `:main`.** `.github/workflows/build-publish.yml` calls the `T5-labs/.github` reusable workflow on any `main` push whose commit message contains `publish`. That CI builds an ARM64-only image with an empty `NEXT_PUBLIC_MCP_URL` and pushes it to the same `:main` and `:<sha>` tags. On an amd64 prod host with Watchtower, it overwrites your good amd64 image (wrong arch + empty client URL). Mitigation: push to a CI-untouched tag (e.g. `:prod`) and point compose/Watchtower at that tag — or don't rely on Hub for this host (use the PRIMARY local-build path).

If you use this path, push to a CI-untouched tag such as `:prod` and point compose/Watchtower at it.

**Step 1.** Confirm the commit to deploy.

```bash
git pull
git log --oneline -5
```

Confirm with the user that you are on the commit they want deployed.

**Step 2.** Build the image with the public MCP URL baked in. Tag it with a CI-untouched tag (`:prod` recommended).

```bash
docker build \
  --build-arg NEXT_PUBLIC_MCP_URL="$NEXT_PUBLIC_MCP_URL" \
  -t "${DOCKER_TAG:-aaarbuckle/project-merkle:prod}" \
  .
```

**Step 3.** Push to Docker Hub.

```bash
docker push "${DOCKER_TAG:-aaarbuckle/project-merkle:prod}"
```

**Step 4.** Verify the push landed.

```bash
docker manifest inspect "${DOCKER_TAG:-aaarbuckle/project-merkle:prod}"
```

The output should show a fresh digest. Confirm the `created` timestamp matches the build you just pushed.

**Step 5.** Tell the user the push succeeded and report the new image digest. If the target runs Watchtower, it will pull and restart within its poll interval (default 5 minutes).

---

## What NOT to do

- Do NOT build or push without `--build-arg NEXT_PUBLIC_MCP_URL=...`. The browser bundle will end up with an empty URL and the app will be silently broken in prod.
- Do NOT run `npm run db:migrate` against a Docker deploy. Migrations run automatically on container boot (`instrumentation.ts`, gated by `RUN_DB_MIGRATIONS=true`), and `drizzle-kit` is not installed in the runner image.
- Do NOT echo or log `POSTGRES_PASSWORD`, `MCP_SESSION_TOKEN_SECRET`, or any other runtime secret. Build-time `NEXT_PUBLIC_MCP_URL` is public (it is literally in the client bundle), so it is safe to print.

---

## After deploy

The host's `.env` file must contain `POSTGRES_PASSWORD` — the compose file's `:?` fail-fast guard will refuse to start without it. Confirm the user has it set before the first deploy. `MCP_SESSION_TOKEN_SECRET` is optional (compose `:-` default, never blocks startup) and is currently an unused placeholder for future connection-level auth.

Universal post-deploy check (both models): confirm `[migrate] up to date` in `docker compose logs app` and that `curl -fsS http://localhost:7423/api/health` returns `200 {"status":"ok",...}` (a `503` means the DB is degraded).

Only if the target runs Watchtower: it handles the pull-and-restart automatically, so no manual `docker compose pull` or restart is needed once it is running. With the PRIMARY local-build path there is no Watchtower — `docker compose up -d` applies the new image directly.
