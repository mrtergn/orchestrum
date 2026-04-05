import { NextResponse } from "next/server";
import { getSession, startSession, advanceSession } from "../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get("id") ?? "default").trim();
  const s = getSession(id);
  return NextResponse.json({ ok: true, session: s }, { headers: nocache() });
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get("id") ?? "default").trim();
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const action = String(body?.action ?? "").trim();
  const s = action === "start" ? startSession(id) : action === "advance" ? advanceSession(id) : getSession(id);
  return NextResponse.json({ ok: true, session: s }, { headers: nocache() });
}

function nocache() {
  const h = new Headers();
  h.set("cache-control", "no-store, no-cache, must-revalidate");
  h.set("pragma", "no-cache");
  h.set("expires", "0");
  return h;
}

