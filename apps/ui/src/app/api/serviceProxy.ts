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
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: "no-store"
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const response = await fetch(target, init);
  const resHeaders = new Headers(response.headers);
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate");
  resHeaders.set("pragma", "no-cache");
  resHeaders.set("expires", "0");
  return new NextResponse(response.body, {
    status: response.status,
    headers: resHeaders
  });
}

export function serviceUrl() {
  return SERVICE_URL;
}
