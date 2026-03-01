import { proxyRequest } from "../../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return proxyRequest(req, `/api/org/nodes/${params.id}`);
}
