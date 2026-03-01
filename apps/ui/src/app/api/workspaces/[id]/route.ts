import { proxyRequest } from "../../serviceProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return proxyRequest(req, `/api/workspaces/${params.id}`);
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return proxyRequest(req, `/api/workspaces/${params.id}`);
}
