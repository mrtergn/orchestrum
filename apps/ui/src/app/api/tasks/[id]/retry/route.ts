import { proxyRequest } from "../../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return proxyRequest(req, `/api/tasks/${params.id}/retry`);
}
