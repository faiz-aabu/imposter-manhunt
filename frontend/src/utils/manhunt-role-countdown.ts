import type { ManhuntTeam } from "@impostor/api";

export function getManhuntRoleRoute(
  team: ManhuntTeam,
): "/manhunt/map" | "/manhunt/countdown" {
  return team === "runner" ? "/manhunt/map" : "/manhunt/countdown";
}
