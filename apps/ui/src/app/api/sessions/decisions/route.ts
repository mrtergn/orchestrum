import { NextResponse } from "next/server";
import { serviceUrl } from "../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Validate payload before forwarding to the service for better UX and audit safety.
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : undefined;
  const decision = typeof body?.decision === "string" ? body.decision.trim() : "";
  const note = typeof body?.note === "string" ? body.note.trim() : undefined;
  const data = body?.data && typeof body.data === "object" ? body.data : undefined;

  const allowed = new Set(["approve", "send_back", "resume", "cancel", "note"]);
  if (!runId) return NextResponse.json({ ok: false, error: "runId required" }, { status: 400 });
  if (!decision || !allowed.has(decision)) {
    return NextResponse.json({ ok: false, error: "decision invalid" }, { status: 400 });
  }

  const res = await fetch(`${serviceUrl()}/sessions/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ runId, workspaceId, decision, note, data })
  });
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  return new NextResponse(res.body, { status: res.status, headers });
}
