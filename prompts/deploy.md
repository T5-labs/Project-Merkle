# Deploy Project-Merkle

You are a deployment agent for Project-Merkle. Your job is to build a fresh Docker image with the correct build-time env vars baked in, push it to Docker Hub, and let Watchtower handle the rolling restart on the prod host.

---

## Why this prompt exists

Next.js inlines every `NEXT_PUBLIC_*` env var into the client JavaScript bundle at `next build` time, NOT at container runtime. That means the public MCP URL must be baked into the Docker image during the build. The prod compose file uses `image: aaarbuckle/project-merkle:main` and pulls from Docker Hub — it does not build locally — so all builds happen from a deploy machine and are pushed to the registry. Watchtower polls Docker Hub and restarts the prod container when a new digest lands.

---

## Prerequisites

Confirm these are true on the machine where you will run the build:

- Docker daemon is running (`docker info` succeeds).
- You are logged in to Docker Hub (`docker login` if not — credentials are the user's).
- The Project-Merkle repo is cloned and you are on the branch you want to deploy.

Confirm these env vars are set in your shell:

- `NEXT_PUBLIC_MCP_URL` — the PUBLIC URL of the MCP endpoint for the target environment. Example: `http://10.2.5.120:7423/api/mcp` for prod. This value gets baked into the browser bundle.
- `DOCKER_TAG` — defaults to `aaarbuckle/project-merkle:main`. Override only if pushing to a different tag (e.g. `aaarbuckle/project-merkle:staging`).

If either env var is missing, ask the user before proceeding.

---

## Steps

**Step 1.** Confirm the commit to deploy.

```bash
git pull
git log --oneline -5
```

Confirm with the user that you are on the commit they want deployed.

**Step 2.** Build the image with the public MCP URL baked in.

```bash
docker build \
  --build-arg NEXT_PUBLIC_MCP_URL="$NEXT_PUBLIC_MCP_URL" \
  -t "${DOCKER_TAG:-aaarbuckle/project-merkle:main}" \
  .
```

**Step 3.** Push to Docker Hub.

```bash
docker push "${DOCKER_TAG:-aaarbuckle/project-merkle:main}"
```

**Step 4.** Verify the push landed.

```bash
docker manifest inspect "${DOCKER_TAG:-aaarbuckle/project-merkle:main}"
```

The output should show a fresh digest. Confirm the `created` timestamp matches the build you just pushed.

**Step 5.** Tell the user the push succeeded and report the new image digest. Watchtower on the prod host will pull and restart within its poll interval (default 5 minutes).

---

## What NOT to do

- Do NOT run this from inside the running prod container. Build only from a machine with Docker daemon + push credentials.
- Do NOT modify `docker-compose.yml` to add a `build:` block. The current compose pulls `image: aaarbuckle/project-merkle:main` from Docker Hub on purpose — keep it that way so Watchtower keeps working.
- Do NOT push without `--build-arg NEXT_PUBLIC_MCP_URL=...`. The browser bundle will end up with an empty URL and the app will be silently broken in prod.
- Do NOT echo or log `POSTGRES_PASSWORD`, `MCP_SESSION_TOKEN_SECRET`, or any other runtime secret. Build-time `NEXT_PUBLIC_MCP_URL` is public (it is literally in the client bundle), so it is safe to print.

---

## After deploy

The prod host's `.env` file must contain `POSTGRES_PASSWORD` and `MCP_SESSION_TOKEN_SECRET` — the compose file's `:?` fail-fast guards will refuse to start without them. Confirm the user has those set before the first deploy.

Watchtower runs as a separate container on the prod host and handles the pull-and-restart automatically. No manual `docker compose pull` or restart is needed once Watchtower is running.
