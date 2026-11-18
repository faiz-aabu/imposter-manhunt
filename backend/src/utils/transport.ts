import { TLSSocket } from "node:tls";
import type { IncomingMessage } from "node:http";
import type { BackendConfig } from "../config/env.js";

export function isSecureTransport(
  request: IncomingMessage,
  clientIpMode: BackendConfig["clientIpMode"],
  trustProxyHops: number,
): boolean {
  if (request.socket instanceof TLSSocket && request.socket.encrypted) {
    return true;
  }
  if (clientIpMode === "socket" && trustProxyHops === 0) {
    return false;
  }

  const header = request.headers["x-forwarded-proto"];
  if (clientIpMode === "railway") {
    return typeof header === "string" && header.trim().toLowerCase() === "https";
  }

  const forwardedProtocol = (Array.isArray(header) ? header.join(",") : header)
    ?.split(",")
    .map((protocol) => protocol.trim().toLowerCase())
    .filter(Boolean)
    .at(-1);
  return forwardedProtocol === "https";
}
