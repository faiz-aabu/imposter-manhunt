export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined) {
    return true;
  }
  return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}
