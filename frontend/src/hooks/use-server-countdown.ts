import { useEffect, useState } from "react";

export function useServerCountdown(
  deadline: string | undefined,
  serverTimeOffsetMs: number | null,
): { remainingSeconds: number | null; label: string } {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline || serverTimeOffsetMs === null) {
      setRemainingSeconds(null);
      return;
    }

    const updateRemaining = () => {
      setRemainingSeconds(
        getCountdownRemainingSeconds(
          deadline,
          serverTimeOffsetMs,
          Date.now(),
        ),
      );
    };
    updateRemaining();
    const interval = setInterval(updateRemaining, 1_000);
    return () => clearInterval(interval);
  }, [deadline, serverTimeOffsetMs]);

  if (remainingSeconds === null || serverTimeOffsetMs === null) {
    return { remainingSeconds: null, label: "--:--" };
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return {
    remainingSeconds,
    label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
  };
}

export function getCountdownRemainingSeconds(
  deadline: string | undefined,
  serverTimeOffsetMs: number | null,
  clientNowMs: number,
): number | null {
  if (
    !deadline ||
    serverTimeOffsetMs === null ||
    !Number.isFinite(serverTimeOffsetMs) ||
    !Number.isFinite(clientNowMs)
  ) {
    return null;
  }

  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    return null;
  }

  return Math.max(
    0,
    Math.ceil((deadlineMs - (clientNowMs + serverTimeOffsetMs)) / 1_000),
  );
}

export function isCountdownOpen(remainingSeconds: number | null): boolean {
  return remainingSeconds !== null && remainingSeconds > 0;
}
