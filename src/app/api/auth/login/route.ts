import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { attachSessionCookies, createSessionForUser, verifyPassword } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");

    if (!username || !password) {
      throw new ApiError(400, "Username and password are required.");
    }

    const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    const row = rows[0];

    // Always run bcrypt.compare even on unknown users to reduce user
    // enumeration via timing, using a static dummy hash.
    const validHash = row?.passwordHash ?? "$2a$12$C6UzMDM.H6dfI/f/IKcEeO/sIn4YEmZfHDOgP1EhQjSPTvV3Pv0uu";
    const ok = await verifyPassword(password, validHash);

    if (!row || !ok) {
      throw new ApiError(401, "Invalid username or password.");
    }

    const session = await createSessionForUser(row.id);
    const response = NextResponse.json({
      user: { id: row.id, username: row.username, role: row.role, canDelete: row.canDelete },
    });
    attachSessionCookies(response, session);
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
