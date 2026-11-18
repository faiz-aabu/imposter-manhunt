import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import { getClientIp } from "./client-ip.js";

test("Railway mode accepts valid IPv4 and IPv6 X-Real-IP values", () => {
  const ipv4Headers: IncomingHttpHeaders = { "x-real-ip": "203.0.113.8" };
  const ipv6Headers: IncomingHttpHeaders = { "x-real-ip": "2001:db8::8" };

  assert.equal(getClientIp(ipv4Headers, "127.0.0.1", "railway", 0), "203.0.113.8");
  assert.equal(getClientIp(ipv6Headers, "127.0.0.1", "railway", 0), "2001:db8::8");
});

test("Railway mode rejects missing, invalid, comma-separated, and repeated X-Real-IP", () => {
  const invalidHeaders: IncomingHttpHeaders[] = [
    { "x-forwarded-for": "203.0.113.4" },
    { "x-real-ip": "not-an-ip" },
    { "x-real-ip": "203.0.113.4, 198.51.100.2" },
    { "x-real-ip": ["203.0.113.4", "198.51.100.2"] },
  ];

  for (const headers of invalidHeaders) {
    assert.equal(getClientIp(headers, "127.0.0.1", "railway", 0), undefined);
  }
});

test("Railway mode ignores X-Forwarded-For for client-IP identification", () => {
  const headers: IncomingHttpHeaders = {
    "x-real-ip": "203.0.113.4",
    "x-forwarded-for": "198.51.100.2",
  };
  const missingRealIp: IncomingHttpHeaders = {
    "x-forwarded-for": "198.51.100.2",
  };

  assert.equal(getClientIp(headers, "127.0.0.1", "railway", 0), "203.0.113.4");
  assert.equal(
    getClientIp(missingRealIp, "127.0.0.1", "railway", 0),
    undefined,
  );
});

test("local socket mode uses the remote address and ignores forwarding headers", () => {
  const headers: IncomingHttpHeaders = {
    "x-real-ip": "203.0.113.4",
    "x-forwarded-for": "198.51.100.2",
  };

  assert.equal(
    getClientIp(headers, "192.168.1.12", "socket", 0),
    "192.168.1.12",
  );
});
