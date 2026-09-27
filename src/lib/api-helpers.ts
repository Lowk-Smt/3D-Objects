import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AuthError || err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }

  console.error(err);
  return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
}
