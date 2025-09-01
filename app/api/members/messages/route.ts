import { NextResponse } from "next/server";
import { getRoomMessages, type ForceOption } from "@/lib/membersApi";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const force: ForceOption = searchParams.get("force") === "1" ? 1 : 0;
  try {
    const token = process.env.MEMBERS_token ?? process.env.MEMBERS_TOKEN;
    const messages = await getRoomMessages(196320, { force, token });
    return NextResponse.json(messages);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
} 