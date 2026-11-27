import { create } from "zustand";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export type ServerClockStatus = "idle" | "syncing" | "ready" | "failed";

export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  latestConnectionError: string | null;
  serverClockStatus: ServerClockStatus;
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
  setLatestConnectionError: (message: string | null) => void;
  setServerClockStatus: (status: ServerClockStatus) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  isConnected: false,
  isConnecting: false,
  isReconnecting: false,
  latestConnectionError: null,
  serverClockStatus: "idle",
  status: "idle",
  setStatus: (status) =>
    set({
      status,
      isConnected: status === "connected",
      isConnecting: status === "connecting",
      isReconnecting: status === "reconnecting",
    }),
  setLatestConnectionError: (latestConnectionError) =>
    set({ latestConnectionError }),
  setServerClockStatus: (serverClockStatus) => set({ serverClockStatus }),
}));
