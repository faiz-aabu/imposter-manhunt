import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundaryCircleGeoJson,
  MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS,
} from "../src/utils/manhunt-map.ts";

test("boundary circle closes its polygon ring", () => {
  const circle = createBoundaryCircleGeoJson(
    { latitude: 0, longitude: 0 },
    100,
  );
  const ring = circle.features[0].geometry.coordinates[0];

  assert.equal(ring.length, 65);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test("boundary vertices follow the requested geodesic radius", () => {
  const center = { latitude: 72, longitude: 24 };

  for (const radiusMeters of [100, 1_000]) {
    const circle = createBoundaryCircleGeoJson(center, radiusMeters);
    const ring = circle.features[0].geometry.coordinates[0];

    for (const [longitude, latitude] of ring.slice(0, -1)) {
      assert.ok(
        Math.abs(haversineMeters(center, { latitude, longitude }) - radiusMeters) <
          0.01,
      );
    }
  }
});

test("visual outer boundary is exactly 20 metres beyond the playable radius", () => {
  const center = { latitude: 72, longitude: 24 };

  assert.equal(MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS, 20);
  for (const playableRadiusMeters of [100, 1_000]) {
    const outerCircle = createBoundaryCircleGeoJson(
      center,
      playableRadiusMeters + MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS,
    );
    const ring = outerCircle.features[0].geometry.coordinates[0];

    for (const [longitude, latitude] of ring.slice(0, -1)) {
      assert.ok(
        Math.abs(
          haversineMeters(center, { latitude, longitude }) -
            (playableRadiusMeters + 20),
        ) < 0.01,
      );
    }
  }
});

function haversineMeters(first, second) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(haversine));
}
