import { proxyRequest } from "../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return proxyRequest(req, "/api/agents");
}

export async function POST(req: Request) {
  return proxyRequest(req, "/api/agents");
}
