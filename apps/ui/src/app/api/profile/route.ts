import { proxyRequest } from "../serviceProxy";

export async function GET(req: Request) {
  return proxyRequest(req, "/profile");
}

export async function PUT(req: Request) {
  return proxyRequest(req, "/profile");
}
