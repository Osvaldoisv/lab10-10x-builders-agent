import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL!));

  await supabase
    .from("agent_sessions")
    .update({ status: "closed" })
    .eq("user_id", user.id)
    .eq("channel", "web")
    .eq("status", "active");

  return NextResponse.redirect(new URL("/chat", process.env.NEXT_PUBLIC_APP_URL!));
}
