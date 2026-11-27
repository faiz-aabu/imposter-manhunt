export function shouldShowFirstLaunchTutorial(
  tutorialCompleted: boolean,
  hasSavedRoomSession: boolean,
  hasActiveRoom: boolean,
): boolean {
  return !tutorialCompleted && !hasSavedRoomSession && !hasActiveRoom;
}
