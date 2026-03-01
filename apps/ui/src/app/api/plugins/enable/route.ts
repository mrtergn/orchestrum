import { proxyRequest } from "../../serviceProxy";

export async function POST(req: Request) {
  return proxyRequest(req, "/plugins/enable");
}
