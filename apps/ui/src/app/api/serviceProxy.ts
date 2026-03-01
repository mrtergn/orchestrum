import { NextResponse } from "next/server";

const SERVICE_URL =
  process.env.ORCHESTRUM_SERVICE_URL ??
  process.env.NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL ??
  "http://localhost:4137";

export async function proxyRequest(req: Request, path: string) {
  const url = new URL(req.url);
  const target = `${SERVICE_URL}${path}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: req.method,
    headers
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const response = await fetch(target, init);
  const resHeaders = new Headers(response.headers);
  return new NextResponse(response.body, {
    status: response.status,
    headers: resHeaders
  });
}

export function serviceUrl() {
  return SERVICE_URL;
}
