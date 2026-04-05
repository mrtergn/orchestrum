import { NextResponse } from "next/server";
import { recordValidation } from "../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get("id") ?? "default").trim();
  const ua = req.headers.get("user-agent") ?? "unknown";
  const s = recordValidation(id, ua);
  return NextResponse.json({ ok: true, session: s }, { headers: nocache() });
}

function nocache() {
  const h = new Headers();
  h.set("cache-control", "no-store, no-cache, must-revalidate");
  h.set("pragma", "no-cache");
  h.set("expires", "0");
  return h;
}

