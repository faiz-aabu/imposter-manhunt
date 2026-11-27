import { create } from "zustand";
import type { ManhuntBoundary, PlayerId, Room } from "@impostor/api";

interface RoomState {
  room: Room | null;
  playerId: PlayerId | null;
  notice: string | null;
  activity: string | null;
  manhuntBoundaryRoomCode: string | null;
  manhuntBoundary: ManhuntBoundary | null;
  setSession: (room: Room, playerId: PlayerId, notice?: string | null) => void;
  setRoom: (room: Room) => void;
  setNotice: (notice: string | null) => void;
  setActivity: (activity: string | null) => void;
  setManhuntBoundary: (roomCode: string, boundary: ManhuntBoundary | null) => void;
  clearSession: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  room: null,
  playerId: null,
  notice: null,
  activity: null,
  manhuntBoundaryRoomCode: null,
  manhuntBoundary: null,
  setSession: (room, playerId, notice = null) =>
    set((state) => ({
      room,
      playerId,
      notice,
      activity: null,
      ...(state.manhuntBoundaryRoomCode === room.code
        ? {}
        : { manhuntBoundaryRoomCode: null, manhuntBoundary: null }),
    })),
  setRoom: (room) => set({ room }),
  setNotice: (notice) => set({ notice }),
  setActivity: (activity) => set({ activity }),
  setManhuntBoundary: (roomCode, boundary) =>
    set({ manhuntBoundaryRoomCode: roomCode, manhuntBoundary: boundary }),
  clearSession: () =>
    set({
      room: null,
      playerId: null,
      notice: null,
      activity: null,
      manhuntBoundaryRoomCode: null,
      manhuntBoundary: null,
    }),
}));
