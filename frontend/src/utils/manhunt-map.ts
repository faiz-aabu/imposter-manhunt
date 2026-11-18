import type { Coordinates } from "@impostor/api";

export const OPENFREEMAP_STYLE =
  "https://tiles.openfreemap.org/styles/liberty";

export const MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS = 20;

const EARTH_RADIUS_METERS = 6_371_008.8;
const CIRCLE_SEGMENTS = 64;

export interface BoundaryCircleFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, never>;
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    };
  }>;
}

export function createBoundaryCircleGeoJson(
  center: Coordinates,
  radiusMeters: number,
): BoundaryCircleFeatureCollection {
  const latitude = toRadians(center.latitude);
  const longitude = toRadians(center.longitude);
  const angularDistance = radiusMeters / EARTH_RADIUS_METERS;
  const coordinates: number[][] = [];

  for (let index = 0; index < CIRCLE_SEGMENTS; index += 1) {
    const bearing = (index / CIRCLE_SEGMENTS) * 2 * Math.PI;
    const destinationLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const destinationLongitude =
      longitude +
      Math.atan2(
        Math.sin(bearing) *
          Math.sin(angularDistance) *
          Math.cos(latitude),
        Math.cos(angularDistance) -
          Math.sin(latitude) * Math.sin(destinationLatitude),
      );

    coordinates.push([
      toDegrees(destinationLongitude),
      toDegrees(destinationLatitude),
    ]);
  }
  coordinates.push(coordinates[0]!);

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [coordinates],
        },
      },
    ],
  };
}

export function getBoundaryCircleBounds(
  circle: BoundaryCircleFeatureCollection,
): [number, number, number, number] {
  const ring = circle.features[0]!.geometry.coordinates[0]!;
  const longitudes = ring.map(([longitude]) => longitude);
  const latitudes = ring.map(([, latitude]) => latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const longitudePadding = Math.max((east - west) * 0.2, 0.001);
  const latitudePadding = Math.max((north - south) * 0.2, 0.001);

  return [
    west - longitudePadding,
    south - latitudePadding,
    east + longitudePadding,
    north + latitudePadding,
  ];
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number) {
  return (radians * 180) / Math.PI;
}
