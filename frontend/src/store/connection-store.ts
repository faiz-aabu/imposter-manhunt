import { create } from "zustand";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  latestConnectionError: string | null;
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
  setLatestConnectionError: (message: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  isConnected: false,
  isConnecting: false,
  isReconnecting: false,
  latestConnectionError: null,
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
}));
