import { NextResponse } from "next/server";
import { setAudit } from "../store";
import { serviceUrl } from "../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get("id") ?? "default").trim();

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const outcome = body?.outcome === "approved" ? "approved" : body?.outcome === "changes_requested" ? "changes_requested" : undefined;
  const notes = typeof body?.notes === "string" ? body.notes : undefined;

  if (!outcome) {
    return NextResponse.json({ ok: false, error: "outcome required" }, { status: 400, headers: nocache() });
  }

  // Update local audit record for UI traceability.
  const s = setAudit(id, outcome, notes);

  // If approved, also notify the session-decision service for consistency.
  try {
    if (outcome === "approved") {
      await fetch(`${serviceUrl()}/sessions/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ runId: id, decision: "approve", note: notes })
      });
    }
  } catch {
    // Non-fatal for local audit; UI will still reflect audit outcome
  }

  return NextResponse.json({ ok: true, session: s }, { headers: nocache() });
}

function nocache() {
  const h = new Headers();
  h.set("cache-control", "no-store, no-cache, must-revalidate");
  h.set("pragma", "no-cache");
  h.set("expires", "0");
  return h;
}

