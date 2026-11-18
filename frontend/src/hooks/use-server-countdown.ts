import { useEffect, useState } from "react";

export function useServerCountdown(
  deadline: string | undefined,
  serverTimeOffsetMs: number,
): { remainingSeconds: number | null; label: string } {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline) {
      setRemainingSeconds(null);
      return;
    }

    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs)) {
      setRemainingSeconds(null);
      return;
    }

    const updateRemaining = () => {
      setRemainingSeconds(
        Math.max(
          0,
          Math.ceil((deadlineMs - (Date.now() + serverTimeOffsetMs)) / 1_000),
        ),
      );
    };
    updateRemaining();
    const interval = setInterval(updateRemaining, 1_000);
    return () => clearInterval(interval);
  }, [deadline, serverTimeOffsetMs]);

  if (remainingSeconds === null) {
    return { remainingSeconds: null, label: "--:--" };
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return {
    remainingSeconds,
    label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
  };
}
