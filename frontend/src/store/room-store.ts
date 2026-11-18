import { create } from "zustand";
import type { PlayerId, Room } from "@impostor/api";

interface RoomState {
  room: Room | null;
  playerId: PlayerId | null;
  notice: string | null;
  activity: string | null;
  setSession: (room: Room, playerId: PlayerId, notice?: string | null) => void;
  setRoom: (room: Room) => void;
  setNotice: (notice: string | null) => void;
  setActivity: (activity: string | null) => void;
  clearSession: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  room: null,
  playerId: null,
  notice: null,
  activity: null,
  setSession: (room, playerId, notice = null) =>
    set({ room, playerId, notice, activity: null }),
  setRoom: (room) => set({ room }),
  setNotice: (notice) => set({ notice }),
  setActivity: (activity) => set({ activity }),
  clearSession: () =>
    set({
      room: null,
      playerId: null,
      notice: null,
      activity: null,
    }),
}));
