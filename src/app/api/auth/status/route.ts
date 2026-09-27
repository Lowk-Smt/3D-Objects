import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { handleApiError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Tells the frontend whether to show the "create the first owner account"
// setup screen or a normal login screen.
export async function GET() {
  try {
    const rows = await db.select({ id: users.id }).from(users).limit(1);
    return NextResponse.json({ hasUsers: rows.length > 0 });
  } catch (err) {
    return handleApiError(err);
  }
}
