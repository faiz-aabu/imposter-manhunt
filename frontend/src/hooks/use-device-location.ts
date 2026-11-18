import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState, Linking } from "react-native";
import type * as Location from "expo-location";
import {
  DeviceLocationError,
  getCurrentDeviceLocation,
  getForegroundLocationPermission,
  requestForegroundLocationPermission,
  watchDeviceLocation,
} from "../services/location-service";

export type DeviceLocationStatus =
  | "loading"
  | "requesting-permission"
  | "locating"
  | "ready"
  | "permission-denied"
  | "services-disabled"
  | "unavailable"
  | "error";

interface DeviceLocationState {
  location: Location.LocationObject | null;
  status: DeviceLocationStatus;
  error: string | null;
  permissionCanAskAgain: boolean;
}

const INITIAL_STATE: DeviceLocationState = {
  location: null,
  status: "loading",
  error: null,
  permissionCanAskAgain: true,
};

export function useDeviceLocation() {
  const [state, setState] = useState(INITIAL_STATE);
  const isScreenFocused = useRef(false);
  const isTrackingActive = useRef(false);
  const requestInProgress = useRef(false);
  const subscription = useRef<Location.LocationSubscription | null>(null);

  const startLocationTracking = useCallback(async () => {
    if (!isTrackingActive.current || requestInProgress.current) {
      return;
    }

    requestInProgress.current = true;
    subscription.current?.remove();
    subscription.current = null;
    setState({
      ...INITIAL_STATE,
      status: "requesting-permission",
    });

    try {
      let permission = await getForegroundLocationPermission();
      if (!isTrackingActive.current) {
        return;
      }

      if (!permission.granted && permission.canAskAgain) {
        permission = await requestForegroundLocationPermission();
      }
      if (!isTrackingActive.current) {
        return;
      }

      if (!permission.granted) {
        setState({
          location: null,
          status: "permission-denied",
          error: null,
          permissionCanAskAgain: permission.canAskAgain,
        });
        return;
      }

      setState((current) => ({
        ...current,
        status: "locating",
        error: null,
        permissionCanAskAgain: permission.canAskAgain,
      }));

      const location = await getCurrentDeviceLocation();
      if (!isTrackingActive.current) {
        return;
      }
      setState({
        location,
        status: "ready",
        error: null,
        permissionCanAskAgain: permission.canAskAgain,
      });

      const nextSubscription = await watchDeviceLocation(
        (nextLocation) => {
          if (!isTrackingActive.current) {
            return;
          }
          setState((current) => ({
            ...current,
            location: nextLocation,
            status: "ready",
            error: null,
          }));
        },
        (message) => {
          if (!isTrackingActive.current) {
            return;
          }
          setState((current) => ({
            ...current,
            location: null,
            status: "error",
            error: message,
          }));
        },
      );

      if (isTrackingActive.current) {
        subscription.current = nextSubscription;
      } else {
        nextSubscription.remove();
      }
    } catch (error) {
      if (!isTrackingActive.current) {
        return;
      }

      if (error instanceof DeviceLocationError) {
        setState({
          location: null,
          status: error.reason,
          error: error.message,
          permissionCanAskAgain: true,
        });
      } else {
        setState({
          location: null,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "The location service encountered an unexpected error.",
          permissionCanAskAgain: true,
        });
      }
    } finally {
      requestInProgress.current = false;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      isScreenFocused.current = true;
      isTrackingActive.current =
        AppState.currentState === null || AppState.currentState === "active";
      const appStateSubscription = AppState.addEventListener(
        "change",
        (nextState) => {
          isTrackingActive.current =
            isScreenFocused.current && nextState === "active";
          if (!isTrackingActive.current) {
            subscription.current?.remove();
            subscription.current = null;
            return;
          }
          void startLocationTracking();
        },
      );
      void startLocationTracking();

      return () => {
        isScreenFocused.current = false;
        isTrackingActive.current = false;
        appStateSubscription.remove();
        subscription.current?.remove();
        subscription.current = null;
      };
    }, [startLocationTracking]),
  );

  const openAppSettings = useCallback(async () => {
    try {
      await Linking.openSettings();
    } catch (error) {
      if (!isTrackingActive.current) {
        return;
      }
      setState((current) => ({
        ...current,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Could not open the app's location settings.",
      }));
    }
  }, []);

  return {
    ...state,
    retry: startLocationTracking,
    openAppSettings,
  };
}
