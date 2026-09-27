import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";

export class ApiError extends Error {
  status: number;
  headers?: Record<string, string>;

  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Postgres error codes we can translate into something a user understands. */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Single exit point for API failures. Known/expected problems return their
 * message; anything unexpected is logged with full detail server-side and
 * reported as a generic 500 so internal state is never leaked to the browser.
 */
export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AuthError || err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status, headers: err.headers });
  }

  const code = pgErrorCode(err);
  if (code === "23505") {
    return NextResponse.json({ error: "That name is already taken." }, { status: 409 });
  }
  if (code === "23503") {
    return NextResponse.json(
      { error: "This change refers to a record that no longer exists. Refresh and try again." },
      { status: 409 },
    );
  }
  if (code && code.startsWith("08")) {
    console.error("[api] Database unavailable:", err);
    return NextResponse.json({ error: "The database is unavailable. Please try again in a moment." }, { status: 503 });
  }

  console.error("[api] Unexpected error:", err);
  return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
}
