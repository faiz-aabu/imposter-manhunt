import { useCallback, useEffect } from "react";
import { connectSocket, disconnectSocket } from "../services/socket-client";
import { useConnectionStore } from "../store/connection-store";

export function useSocketConnection(connectOnMount = false) {
  const isConnected = useConnectionStore((state) => state.isConnected);
  const isConnecting = useConnectionStore((state) => state.isConnecting);
  const isReconnecting = useConnectionStore((state) => state.isReconnecting);
  const latestConnectionError = useConnectionStore(
    (state) => state.latestConnectionError,
  );
  const status = useConnectionStore((state) => state.status);

  const connect = useCallback(() => {
    connectSocket();
  }, []);
  const disconnect = useCallback(() => {
    disconnectSocket();
  }, []);

  useEffect(() => {
    if (!connectOnMount) {
      return;
    }

    try {
      connect();
    } catch {
      // The service records configuration failures in the connection store.
    }

    return disconnect;
  }, [connect, connectOnMount, disconnect]);

  return {
    isConnected,
    isConnecting,
    isReconnecting,
    latestConnectionError,
    status,
    connect,
    disconnect,
  };
}
