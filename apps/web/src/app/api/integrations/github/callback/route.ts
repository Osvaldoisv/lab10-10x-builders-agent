import { NextResponse } from "next/server";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const params = new URLSearchParams();
  searchParams.forEach((value, key) => params.set(key, value));
  return NextResponse.redirect(`${BASE_URL}/api/auth/github/callback?${params.toString()}`);
}
