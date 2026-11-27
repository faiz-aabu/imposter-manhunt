import { useClassicGameStore } from "./classic-game-store";
import { useWordGameStore } from "./word-game-store";

export function resetImpostorGameStores(): void {
  useClassicGameStore.getState().reset();
  useWordGameStore.getState().reset();
}
