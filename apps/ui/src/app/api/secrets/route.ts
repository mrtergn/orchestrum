import { proxyRequest } from "../serviceProxy";

export async function GET(req: Request) {
  return proxyRequest(req, "/api/secrets");
}

export async function POST(req: Request) {
  return proxyRequest(req, "/api/secrets/set");
}
