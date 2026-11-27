import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createBoundaryCircleGeoJson,
  MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS,
} from "../src/utils/manhunt-map.ts";
import { getVisibleFreezeDecoys } from "../src/utils/manhunt-decoys.ts";
import {
  getVisibleLateGameClue,
  getVisibleLateGameWarning,
} from "../src/utils/manhunt-late-game-exposure.ts";

test("late-game clue and warning visibility follows original server deadlines", () => {
  const serverNow = Date.parse("2026-01-01T00:00:10.000Z");
  const clueState = {
    roomCode: "ROOM",
    sessionId: "session",
    serverNow: new Date(serverNow).toISOString(),
    clue: {
      clueId: "clue",
      coordinates: { latitude: 0, longitude: 0 },
      recordedAt: "2026-01-01T00:00:00.000Z",
      exposedAt: "2026-01-01T00:00:05.000Z",
      expiresAt: "2026-01-01T00:00:10.001Z",
    },
  };
  const warningState = {
    roomCode: "ROOM",
    sessionId: "session",
    playerId: "hider",
    serverNow: new Date(serverNow).toISOString(),
    warning: {
      exposureId: "clue",
      startedAt: "2026-01-01T00:00:05.000Z",
      expiresAt: "2026-01-01T00:00:10.000Z",
    },
  };

  assert.equal(getVisibleLateGameClue(clueState, serverNow)?.clueId, "clue");
  assert.equal(getVisibleLateGameWarning(warningState, serverNow), null);
});

test("decoy visibility follows the server-provided expiry deadline", () => {
  const serverNow = Date.parse("2026-01-01T00:00:10.000Z");
  const decoys = [
    {
      decoyId: "active",
      coordinates: { latitude: 0, longitude: 0 },
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:10.001Z",
    },
    {
      decoyId: "expired",
      coordinates: { latitude: 1, longitude: 1 },
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:10.000Z",
    },
  ];

  assert.deepEqual(
    getVisibleFreezeDecoys(decoys, serverNow).map(({ decoyId }) => decoyId),
    ["active"],
  );
});

test("decoy markers are separate from selectable and catchable player markers", async () => {
  const mapSource = await readFile(
    new URL("../src/components/ManhuntMap.tsx", import.meta.url),
    "utf8",
  );
  const routeSource = await readFile(
    new URL("../app/manhunt/map.tsx", import.meta.url),
    "utf8",
  );
  const decoyMapping = mapSource.match(
    /\{decoyLocations\.map\(\(decoy\) => \(([\s\S]*?)\)\)\}/,
  )?.[1];
  assert.ok(decoyMapping, "expected a dedicated Freeze Decoy marker");
  assert.match(decoyMapping, /id=\{`freeze-decoy-\$\{decoy\.decoyId\}`\}/);
  assert.doesNotMatch(decoyMapping, /onPress=/);
  assert.match(decoyMapping, /styles\.remoteMarker/);
  assert.match(routeSource, /decoyLocations=\{activeFreezeDecoys\}/);
  assert.match(routeSource, /revealedLocations=\{revealLocations\}/);

  const catchStart = routeSource.indexOf("  const attemptCatch =");
  const catchEnd = routeSource.indexOf("\n  const activateFootsteps", catchStart);
  assert.ok(catchStart >= 0 && catchEnd > catchStart, "expected a catch handler");
  const catchSource = routeSource.slice(catchStart, catchEnd);
  assert.match(catchSource, /revealLocations\.find/);
  assert.match(catchSource, /targetPlayerId:\s*selectedPlayerId/);
  assert.doesNotMatch(catchSource, /decoyLocations|activeFreezeDecoys/);
});

test("late-game clues render separately and cannot be selected or submitted as catch targets", async () => {
  const mapSource = await readFile(
    new URL("../src/components/ManhuntMap.tsx", import.meta.url),
    "utf8",
  );
  const routeSource = await readFile(
    new URL("../app/manhunt/map.tsx", import.meta.url),
    "utf8",
  );
  const clueMapping = mapSource.match(
    /\{lateGameClue \? \([\s\S]*?\) : null\}/,
  )?.[0];
  assert.ok(clueMapping, "expected a dedicated late-game clue marker");
  assert.match(clueMapping, /id=\{`late-game-clue-\$\{lateGameClue\.clueId\}`\}/);
  assert.match(clueMapping, /styles\.remoteMarker/);
  assert.doesNotMatch(clueMapping, /onPress=/);
  assert.match(routeSource, /lateGameClue=\{activeLateGameClue\}/);
  assert.match(routeSource, /clearLateGameClueState\(clue\.clueId\)/);
  assert.match(routeSource, /clearLateGameWarningState\(warning\.exposureId\)/);
  assert.match(routeSource, /t\("manhunt\.map\.lastKnownExposed"\)/);

  const catchStart = routeSource.indexOf("  const attemptCatch =");
  const catchEnd = routeSource.indexOf("\n  const activateFootsteps", catchStart);
  assert.ok(catchStart >= 0 && catchEnd > catchStart, "expected a catch handler");
  const catchSource = routeSource.slice(catchStart, catchEnd);
  assert.match(catchSource, /revealLocations\.find/);
  assert.match(catchSource, /targetPlayerId:\s*selectedPlayerId/);
  assert.doesNotMatch(catchSource, /lateGameClue|activeLateGameClue/);
});

test("catch confirmation expiry uses the synchronized server deadline and cleans up", async () => {
  const routeSource = await readFile(
    new URL("../app/manhunt/map.tsx", import.meta.url),
    "utf8",
  );
  const normalizedRouteSource = routeSource.replace(/\r\n/g, "\n");
  const effectStart = normalizedRouteSource.indexOf(
    "  useEffect(() => {\n    if (!incomingCatchRequest)",
  );
  const effectEnd = normalizedRouteSource.indexOf("\n  useEffect(", effectStart + 1);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const expiryEffect = normalizedRouteSource.slice(effectStart, effectEnd);

  assert.match(expiryEffect, /return scheduleServerDeadline\(/);
  assert.match(expiryEffect, /incomingCatchRequest\.expiresAt/);
  assert.match(expiryEffect, /serverTimeOffsetMs/);
  assert.match(expiryEffect, /incomingCatchRequest\?\.requestId/);
  assert.match(expiryEffect, /incomingCatchRequest\?\.expiresAt/);
});

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
