import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { BackendConfig } from "../config/env.js";

export type ClientIpMode = BackendConfig["clientIpMode"];

export function getClientIp(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
  mode: ClientIpMode,
  trustProxyHops: number,
): string | undefined {
  if (mode === "railway") {
    const realIp = headers["x-real-ip"];
    return typeof realIp === "string" && isIP(realIp) !== 0
      ? realIp
      : undefined;
  }

  const forwardedFor = headers["x-forwarded-for"];
  const forwardedValues = Array.isArray(forwardedFor)
    ? forwardedFor.join(",")
    : forwardedFor;
  if (trustProxyHops > 0 && forwardedValues) {
    const addresses = forwardedValues
      .split(",")
      .map((address) => address.trim())
      .filter((address) => isIP(address) !== 0);
    const clientIndex = addresses.length - trustProxyHops;
    const address = addresses[clientIndex];
    if (clientIndex >= 0 && address) {
      return address;
    }
  }

  return remoteAddress || "unknown";
}
