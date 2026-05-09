/**
 * Drizzle DB connection helper.
 *
 * SERVER-ONLY — this module imports `postgres` and `server-only`, which
 * will throw at bundle time if accidentally imported from a Client Component.
 * Never import this file from any file marked "use client" or from the
 * pages/_app / layout client boundary.
 *
 * Schema lands in Phase 2 (db/schema.ts).
 */
import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

// `postgres` (the npm package) is the connection driver Drizzle recommends for
// serverless-friendly usage; it works equally well in our long-lived Node setup.
const client = postgres(process.env.DATABASE_URL);

// Passing the schema enables Drizzle's relational query API (db.query.*).
export const db = drizzle(client, { schema });
