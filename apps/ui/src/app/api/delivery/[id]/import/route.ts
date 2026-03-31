import { proxyRequest } from "../../../serviceProxy";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  return proxyRequest(req, `/delivery/${params.id}/import`);
}
