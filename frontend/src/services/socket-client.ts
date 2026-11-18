import {
  CONNECTION_EVENTS,
  ERROR_EVENTS,
} from "@impostor/api";
import type {
  ServerErrorPayload,
  ValidationErrorPayload,
} from "@impostor/api";
import { io } from "socket.io-client";
import { useConnectionStore } from "../store/connection-store";
import type { GameClientSocket } from "./socket-types";
import type { ConnectionState } from "../store/connection-store";

const CONNECTION_TIMEOUT_MS = 10_000;
const RECONNECTION_DELAY_MS = 1_000;
const MAX_RECONNECTION_DELAY_MS = 10_000;

interface SocketListeners {
  connect: () => void;
  disconnect: (reason: string) => void;
  connectError: (error: Error) => void;
  reconnectAttempt: () => void;
  reconnectError: (error: Error) => void;
  reconnectFailed: () => void;
  serverError: (payload: ServerErrorPayload) => void;
  validationError: (payload: ValidationErrorPayload) => void;
}

let clientSocket: GameClientSocket | null = null;
let socketListeners: SocketListeners | null = null;

export function connectSocket(): void {
  let socket: GameClientSocket;
  try {
    socket = getOrCreateSocket();
  } catch (error) {
    setConnectionFailure(error);
    throw error;
  }

  if (socket.connected) {
    useConnectionStore.getState().setStatus("connected");
    return;
  }

  useConnectionStore
    .getState()
    .setStatus(socket.active ? "reconnecting" : "connecting");
  socket.connect();
}

export function disconnectSocket(): void {
  clientSocket?.disconnect();
  useConnectionStore.getState().setStatus("disconnected");
}

export function getSocketClient(): GameClientSocket {
  return getOrCreateSocket();
}

export function getSocketConnectionState(): ConnectionState {
  return useConnectionStore.getState();
}

export function disposeSocket(): void {
  if (clientSocket && socketListeners) {
    clientSocket.off("connect", socketListeners.connect);
    clientSocket.off(CONNECTION_EVENTS.DISCONNECT, socketListeners.disconnect);
    clientSocket.off("connect_error", socketListeners.connectError);
    clientSocket.off(ERROR_EVENTS.SERVER_ERROR, socketListeners.serverError);
    clientSocket.off(
      ERROR_EVENTS.VALIDATION_ERROR,
      socketListeners.validationError,
    );
    clientSocket.io.off("reconnect_attempt", socketListeners.reconnectAttempt);
    clientSocket.io.off("reconnect_error", socketListeners.reconnectError);
    clientSocket.io.off("reconnect_failed", socketListeners.reconnectFailed);
    clientSocket.disconnect();
  }

  clientSocket = null;
  socketListeners = null;
  useConnectionStore.getState().setStatus("disconnected");
}

function getOrCreateSocket(): GameClientSocket {
  if (clientSocket) {
    return clientSocket;
  }

  const url = getApiBaseUrl();
  const socket = io(url, {
    autoConnect: false,
    timeout: CONNECTION_TIMEOUT_MS,
    reconnection: true,
    reconnectionDelay: RECONNECTION_DELAY_MS,
    reconnectionDelayMax: MAX_RECONNECTION_DELAY_MS,
  });
  const listeners = createSocketListeners(socket);
  clientSocket = socket;
  socketListeners = listeners;
  registerSocketListeners(socket, listeners);
  return socket;
}

export function getApiBaseUrl(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!apiUrl) {
    throw new Error(
      "EXPO_PUBLIC_API_URL is not set. Configure it in frontend/.env.local.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL must be a valid HTTP or HTTPS URL.");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("EXPO_PUBLIC_API_URL must use HTTP or HTTPS.");
  }
  if (
    parsedUrl.protocol === "http:" &&
    !isLocalOrPrivateHost(parsedUrl.hostname)
  ) {
    throw new Error(
      "EXPO_PUBLIC_API_URL must use HTTPS for public hosts. HTTP is allowed only for localhost or private-network development.",
    );
  }

  return apiUrl;
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  const octets = host.split(".");
  if (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  ) {
    const [first, second] = octets.map(Number);
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }

  if (host === "::1") return true;
  const firstSegment = host.split(":")[0] ?? "";
  return (
    /^(fc|fd)[0-9a-f]{0,2}$/i.test(firstSegment) ||
    /^fe[89ab][0-9a-f]$/i.test(firstSegment)
  );
}

function createSocketListeners(socket: GameClientSocket): SocketListeners {
  return {
    connect: () => {
      const state = useConnectionStore.getState();
      state.setLatestConnectionError(null);
      state.setStatus("connected");
    },
    disconnect: (reason) => {
      useConnectionStore.getState().setStatus(
        socket.active ? "reconnecting" : "disconnected",
      );
      if (reason === "io server disconnect") {
        useConnectionStore
          .getState()
          .setLatestConnectionError("The server disconnected this client.");
      }
    },
    connectError: (error) => {
      useConnectionStore
        .getState()
        .setLatestConnectionError(error.message);
    },
    reconnectAttempt: () => {
      useConnectionStore.getState().setStatus("reconnecting");
    },
    reconnectError: (error) => {
      useConnectionStore
        .getState()
        .setLatestConnectionError(error.message);
    },
    reconnectFailed: () => {
      useConnectionStore.getState().setStatus("error");
    },
    serverError: (payload) => {
      useConnectionStore
        .getState()
        .setLatestConnectionError(payload.message);
    },
    validationError: (payload) => {
      useConnectionStore
        .getState()
        .setLatestConnectionError(payload.message);
    },
  };
}

function registerSocketListeners(
  socket: GameClientSocket,
  listeners: SocketListeners,
): void {
  socket.on("connect", listeners.connect);
  socket.on(CONNECTION_EVENTS.DISCONNECT, listeners.disconnect);
  socket.on("connect_error", listeners.connectError);
  socket.on(ERROR_EVENTS.SERVER_ERROR, listeners.serverError);
  socket.on(ERROR_EVENTS.VALIDATION_ERROR, listeners.validationError);
  socket.io.on("reconnect_attempt", listeners.reconnectAttempt);
  socket.io.on("reconnect_error", listeners.reconnectError);
  socket.io.on("reconnect_failed", listeners.reconnectFailed);
}

function setConnectionFailure(error: unknown): void {
  useConnectionStore.getState().setStatus("error");
  useConnectionStore
    .getState()
    .setLatestConnectionError(
      error instanceof Error ? error.message : "Could not configure the server connection.",
    );
}
