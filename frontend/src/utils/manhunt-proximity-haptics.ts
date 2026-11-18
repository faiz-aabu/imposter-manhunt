import { MANHUNT_PROXIMITY_COOLDOWN_SECONDS } from "@impostor/api";
import type { ManhuntProximityLevel } from "@impostor/api";

export class ManhuntProximityHapticGate {
  private readonly lastTriggeredAt = new Map<ManhuntProximityLevel, number>();

  shouldTrigger(
    level: ManhuntProximityLevel,
    now: number = Date.now(),
  ): boolean {
    const lastTriggered = this.lastTriggeredAt.get(level);
    if (
      lastTriggered !== undefined &&
      now - lastTriggered < MANHUNT_PROXIMITY_COOLDOWN_SECONDS * 1_000
    ) {
      return false;
    }
    this.lastTriggeredAt.set(level, now);
    return true;
  }

  reset(): void {
    this.lastTriggeredAt.clear();
  }
}
