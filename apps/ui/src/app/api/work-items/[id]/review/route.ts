import { proxyRequest } from "../../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: { id: string } }
) {
  return proxyRequest(req, `/api/work-items/${encodeURIComponent(context.params.id)}/review`);
}
