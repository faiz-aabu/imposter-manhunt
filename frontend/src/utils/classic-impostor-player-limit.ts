export function getMaximumClassicImpostorCount(playerCount: number): number {
  return Math.floor((playerCount - 1) / 2);
}

export function getClassicImpostorCountStepperMaximum(
  playerCount: number,
): number {
  return Math.max(1, getMaximumClassicImpostorCount(playerCount));
}

export function clampClassicImpostorCount(
  impostorCount: number,
  playerCount: number,
): number {
  return Math.min(
    getClassicImpostorCountStepperMaximum(playerCount),
    Math.max(1, impostorCount),
  );
}

export function canStartClassicImpostorGame({
  isHost,
  isConnected,
  isWaiting,
  playerCount,
  minimumPlayerCount,
  allPlayersConnected,
  settingsAreValid,
  impostorCount,
}: {
  isHost: boolean;
  isConnected: boolean;
  isWaiting: boolean;
  playerCount: number;
  minimumPlayerCount: number;
  allPlayersConnected: boolean;
  settingsAreValid: boolean;
  impostorCount: number;
}): boolean {
  return (
    isHost &&
    isConnected &&
    isWaiting &&
    playerCount >= minimumPlayerCount &&
    allPlayersConnected &&
    settingsAreValid &&
    impostorCount <= getMaximumClassicImpostorCount(playerCount)
  );
}
