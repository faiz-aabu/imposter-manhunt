import type { ManhuntFreezeDecoyPayload } from "@impostor/api";

export function getVisibleFreezeDecoys(
  decoys: readonly ManhuntFreezeDecoyPayload[],
  serverNow: number,
): ManhuntFreezeDecoyPayload[] {
  return decoys.filter((decoy) => Date.parse(decoy.expiresAt) > serverNow);
}
