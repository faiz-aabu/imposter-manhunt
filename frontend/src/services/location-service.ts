import * as Location from "expo-location";

export type DeviceLocationFailure =
  | "services-disabled"
  | "unavailable";

export class DeviceLocationError extends Error {
  constructor(
    readonly reason: DeviceLocationFailure,
    message: string,
  ) {
    super(message);
    this.name = "DeviceLocationError";
  }
}

export function getForegroundLocationPermission() {
  return Location.getForegroundPermissionsAsync();
}

export function requestForegroundLocationPermission() {
  return Location.requestForegroundPermissionsAsync();
}

export async function getCurrentDeviceLocation(): Promise<Location.LocationObject> {
  if (!(await Location.hasServicesEnabledAsync())) {
    throw new DeviceLocationError(
      "services-disabled",
      "Turn on device location services and try again.",
    );
  }

  try {
    return await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? ` ${error.message}` : "";
    throw new DeviceLocationError(
      "unavailable",
      `Could not get a usable GPS position. Move to a more open area and try again.${detail}`,
    );
  }
}

export function watchDeviceLocation(
  onLocation: (location: Location.LocationObject) => void,
  onError: (message: string) => void,
): Promise<Location.LocationSubscription> {
  return Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      distanceInterval: 5,
      timeInterval: 3000,
    },
    onLocation,
    onError,
  );
}
