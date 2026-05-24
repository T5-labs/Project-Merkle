export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { VERSION } from "@/lib/version";

export function GET(): Response {
  return NextResponse.json(
    {
      status: "ok",
      name: "project-merkle",
      version: VERSION,
      time: new Date().toISOString(),
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
