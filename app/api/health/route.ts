export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { VERSION } from "@/lib/version";
import { db } from "@/lib/db";

export async function GET(): Promise<Response> {
  const base = {
    name: "project-merkle",
    version: VERSION,
    time: new Date().toISOString(),
  };

  try {
    // Trivial DB probe — fails if the database is unreachable or unmigrated
    // enough to not accept connections. Uses the app's shared drizzle client;
    // no new pool is opened here.
    await db.execute(sql`SELECT 1`);
  } catch {
    return NextResponse.json(
      { status: "degraded", db: "unreachable", ...base },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { status: "ok", ...base },
    { headers: { "Cache-Control": "no-store" } },
  );
}
