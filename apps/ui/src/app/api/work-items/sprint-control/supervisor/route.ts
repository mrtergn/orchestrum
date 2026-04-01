import { proxyRequest } from "../../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return proxyRequest(req, "/api/work-items/sprint-control/supervisor");
}
