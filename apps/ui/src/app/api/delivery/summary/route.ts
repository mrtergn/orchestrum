import { proxyRequest } from "../../serviceProxy";

export async function GET(req: Request) {
  return proxyRequest(req, "/delivery/summary");
}
