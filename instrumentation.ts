/**
 * instrumentation.ts — runs once at server startup.
 *
 * Next.js calls register() a single time when the Node.js server boots and
 * AWAITS it before serving any traffic, so this is the correct place to apply
 * pending Drizzle migrations: the server will not accept requests until the
 * schema is up to date.
 *
 * Gated behind RUN_DB_MIGRATIONS=true so local `next dev` is unaffected unless
 * explicitly opted in. The shipped Docker image sets RUN_DB_MIGRATIONS=true so
 * a fresh deploy comes up with the database fully migrated and ready to go.
 *
 * Uses a dedicated short-lived connection (max: 1) rather than the app's shared
 * pool (lib/db/index.ts), per Drizzle's migration guidance, and closes it when
 * done. On failure it RE-THROWS so the container crashes loudly and (under
 * restart: unless-stopped) retries until the database is reachable.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime should touch the database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Opt-in gate: the Docker image sets this; local dev is left alone.
  if (process.env.RUN_DB_MIGRATIONS !== "true") return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "[migrate] DATABASE_URL environment variable is not set; cannot run migrations.",
    );
  }

  // Dynamic imports keep these server-only modules out of any non-Node bundle.
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");

  // Dedicated single-connection client for migrations only.
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log("[migrate] applying pending migrations...");
    const db = drizzle(sql);
    // Path is resolved relative to process.cwd(), which is the app root
    // (WORKDIR /app) where the Dockerfile copies the drizzle/ folder.
    await migrate(db, { migrationsFolder: "drizzle" });
    console.log("[migrate] up to date");
  } catch (err) {
    console.error("[migrate] migration failed:", err);
    throw err;
  } finally {
    await sql.end();
  }
}
