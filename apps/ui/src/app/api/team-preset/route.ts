import { proxyRequest } from "../serviceProxy";

export async function GET(req: Request) {
  return proxyRequest(req, "/team-preset");
}

export async function PUT(req: Request) {
  return proxyRequest(req, "/team-preset");
}
