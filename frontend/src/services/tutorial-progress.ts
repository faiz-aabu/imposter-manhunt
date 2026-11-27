import * as SecureStore from "expo-secure-store";

const TUTORIAL_COMPLETED_KEY = "impostor.tutorialCompleted";

export async function hasCompletedTutorial(): Promise<boolean> {
  const savedValue = await SecureStore.getItemAsync(TUTORIAL_COMPLETED_KEY);
  if (savedValue === null) {
    return false;
  }
  if (savedValue === "true") {
    return true;
  }
  if (savedValue === "false") {
    return false;
  }

  throw new Error("The saved tutorial completion value is invalid.");
}

export async function markTutorialCompleted(): Promise<void> {
  await SecureStore.setItemAsync(TUTORIAL_COMPLETED_KEY, "true");
}
