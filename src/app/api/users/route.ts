import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireCsrf, requireOwner, requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { isValidUsername } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireSession(req);
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        canDelete: users.canDelete,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.createdAt);

    return NextResponse.json({ users: rows });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);
    requireOwner(ctx.user);

    const body = await req.json().catch(() => null);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    const role = body?.role === "owner" ? "owner" : "member";
    const canDelete = body?.canDelete !== false;

    if (!isValidUsername(username)) {
      throw new ApiError(400, "Username must be 3-32 characters (letters, numbers, . _ -).");
    }
    if (password.length < 8) {
      throw new ApiError(400, "Password must be at least 8 characters.");
    }

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing.length > 0) {
      throw new ApiError(409, `Username "${username}" is already taken.`);
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    await db.insert(users).values({ id, username, passwordHash, role, canDelete });

    const member = { id, username, role, canDelete, createdAt: new Date() };
    broadcast("member-changed", { type: "added", member });

    return NextResponse.json({ user: member }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
