import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { attachSessionCookies, createSessionForUser, hashPassword } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { isValidUsername } from "@/lib/files";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Creates the first "owner" account. Only works while the users table is
// empty — after that, only an existing owner can invite new members via
// POST /api/users.
export async function POST(req: NextRequest) {
  try {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      throw new ApiError(409, "Setup already completed. Ask the workspace owner for an invite.");
    }

    const body = await req.json().catch(() => null);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");

    if (!isValidUsername(username)) {
      throw new ApiError(400, "Username must be 3-32 characters (letters, numbers, . _ -).");
    }
    if (password.length < 8) {
      throw new ApiError(400, "Password must be at least 8 characters.");
    }

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();

    await db.insert(users).values({
      id,
      username,
      passwordHash,
      role: "owner",
      canDelete: true,
    });

    const session = await createSessionForUser(id);
    const response = NextResponse.json({
      user: { id, username, role: "owner", canDelete: true },
    });
    attachSessionCookies(response, session);
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
