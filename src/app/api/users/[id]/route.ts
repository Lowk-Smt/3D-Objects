import { NextRequest, NextResponse } from "next/server";
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireCsrf, requireOwner, requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { broadcast } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function assertNotLastOwner(userId: string) {
  const otherOwners = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "owner"), ne(users.id, userId)));

  if (otherOwners.length === 0) {
    throw new ApiError(400, "There must always be at least one owner.");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);
    requireOwner(ctx.user);

    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) throw new ApiError(404, "User not found.");

    const body = await req.json().catch(() => null);
    const updates: Partial<typeof users.$inferInsert> = {};

    if (typeof body?.canDelete === "boolean") {
      updates.canDelete = body.canDelete;
    }

    if (typeof body?.role === "string" && (body.role === "owner" || body.role === "member")) {
      if (body.role === "member" && target.role === "owner") {
        await assertNotLastOwner(id);
      }
      updates.role = body.role;
    }

    if (typeof body?.password === "string" && body.password.length > 0) {
      if (body.password.length < 8) {
        throw new ApiError(400, "Password must be at least 8 characters.");
      }
      updates.passwordHash = await hashPassword(body.password);
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }

    await db.update(users).set(updates).where(eq(users.id, id));

    const updated = (await db
      .select({ id: users.id, username: users.username, role: users.role, canDelete: users.canDelete, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1))[0];

    broadcast("member-changed", { type: "updated", member: updated });

    return NextResponse.json({ user: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);
    requireOwner(ctx.user);

    if (id === ctx.user.id) {
      throw new ApiError(400, "You can't remove your own account.");
    }

    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) throw new ApiError(404, "User not found.");

    if (target.role === "owner") {
      await assertNotLastOwner(id);
    }

    await db.delete(users).where(eq(users.id, id));

    broadcast("member-changed", { type: "removed", memberId: id });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
