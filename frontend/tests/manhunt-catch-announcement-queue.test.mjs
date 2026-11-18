import assert from "node:assert/strict";
import test from "node:test";
import { MANHUNT_CATCH_NOTIFICATION_DURATION_SECONDS } from "@impostor/api";
import { ManhuntCatchAnnouncementQueue } from "../src/utils/manhunt-catch-announcement-queue.ts";

class ManualScheduler {
  now = 0;
  nextId = 0;
  timers = new Map();

  schedule(callback, delayMs) {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.now + delayMs, callback });
    return () => this.timers.delete(id);
  }

  advance(delayMs) {
    const targetTime = this.now + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort(([, first], [, second]) => first.dueAt - second.dueAt)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.dueAt;
      this.timers.delete(id);
      timer.callback();
    }
    this.now = targetTime;
  }
}

function announcement(requestId) {
  return {
    roomCode: "ABCD",
    sessionId: "session",
    requestId,
    caughtNickname: requestId,
    caughtAt: "2026-01-01T00:00:00.000Z",
  };
}

test("catch announcement dismisses exactly after seven seconds", () => {
  const scheduler = new ManualScheduler();
  const changes = [];
  const queue = new ManhuntCatchAnnouncementQueue(
    (current) => changes.push(current?.requestId ?? null),
    scheduler.schedule.bind(scheduler),
  );

  queue.enqueue(announcement("catch-1"));
  scheduler.advance(
    MANHUNT_CATCH_NOTIFICATION_DURATION_SECONDS * 1_000 - 1,
  );
  assert.deepEqual(changes, ["catch-1"]);
  scheduler.advance(1);
  assert.deepEqual(changes, ["catch-1", null]);
  queue.dispose();
});

test("queued catch announcements display in order without duplicates", () => {
  const scheduler = new ManualScheduler();
  const changes = [];
  const queue = new ManhuntCatchAnnouncementQueue(
    (current) => changes.push(current?.requestId ?? null),
    scheduler.schedule.bind(scheduler),
  );

  queue.enqueue(announcement("catch-1"));
  queue.enqueue(announcement("catch-2"));
  queue.enqueue(announcement("catch-1"));
  scheduler.advance(MANHUNT_CATCH_NOTIFICATION_DURATION_SECONDS * 1_000);
  assert.deepEqual(changes, ["catch-1", "catch-2"]);
  scheduler.advance(MANHUNT_CATCH_NOTIFICATION_DURATION_SECONDS * 1_000);
  assert.deepEqual(changes, ["catch-1", "catch-2", null]);
  queue.dispose();
});
