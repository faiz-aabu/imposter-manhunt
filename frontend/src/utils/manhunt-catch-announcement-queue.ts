import { MANHUNT_CATCH_NOTIFICATION_DURATION_SECONDS } from "@impostor/api";
import type { CatchConfirmedPayload } from "@impostor/api";

type ScheduleTimeout = (
  callback: () => void,
  delayMs: number,
) => () => void;

const scheduleTimeout: ScheduleTimeout = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export class ManhuntCatchAnnouncementQueue {
  private readonly queued: CatchConfirmedPayload[] = [];
  private readonly seenRequestIds = new Set<string>();
  private current: CatchConfirmedPayload | null = null;
  private cancelTimer: (() => void) | null = null;

  constructor(
    private readonly onChange: (
      announcement: CatchConfirmedPayload | null,
    ) => void,
    private readonly schedule: ScheduleTimeout = scheduleTimeout,
  ) {}

  enqueue(announcement: CatchConfirmedPayload): void {
    if (this.seenRequestIds.has(announcement.requestId)) {
      return;
    }
    this.seenRequestIds.add(announcement.requestId);

    if (this.current) {
      this.queued.push(announcement);
      return;
    }
    this.show(announcement);
  }

  dispose(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.current = null;
    this.queued.length = 0;
    this.seenRequestIds.clear();
  }

  private show(announcement: CatchConfirmedPayload): void {
    this.current = announcement;
    this.onChange(announcement);
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.current = null;
      const next = this.queued.shift();
      if (next) {
        this.show(next);
      } else {
        this.onChange(null);
      }
    }, MANHUNT_CATCH_NOTIFICATION_DURATION_SECONDS * 1_000);
  }
}
