import { proxyRequest } from "../../serviceProxy";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return proxyRequest(req, `/delivery/${params.id}`);
}
