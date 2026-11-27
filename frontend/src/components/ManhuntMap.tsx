import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
} from "@maplibre/maplibre-react-native";
import { Target } from "lucide-react-native";
import type { CameraRef } from "@maplibre/maplibre-react-native";
import type { LocationObject } from "expo-location";
import { colors } from "../theme";
import type {
  Coordinates,
  ManhuntFreezeDecoyPayload,
  ManhuntLateGameCluePayload,
  RevealedLocation,
} from "@impostor/api";

import {
  createBoundaryCircleGeoJson,
  getBoundaryCircleBounds,
  MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS,
  OPENFREEMAP_STYLE,
} from "../utils/manhunt-map";

export { OPENFREEMAP_STYLE } from "../utils/manhunt-map";

interface ManhuntMapProps {
  location: LocationObject | null;
  recenterVersion: number;
  onMapReady: () => void;
  onMapError: () => void;
  boundary?: { center: Coordinates; radiusMeters: number } | null;
  missionCircle?: { center: Coordinates; radiusMeters: number } | null;
  revealedLocations?: RevealedLocation[];
  decoyLocations?: ManhuntFreezeDecoyPayload[];
  lateGameClue?: ManhuntLateGameCluePayload | null;
  caughtPlayerIds?: string[];
  selectedPlayerId?: string | null;
  onMarkerPress?: (playerId: string) => void;
}

export function ManhuntMap({
  location,
  recenterVersion,
  onMapReady,
  onMapError,
  boundary,
  missionCircle,
  revealedLocations = [],
  decoyLocations = [],
  lateGameClue = null,
  caughtPlayerIds = [],
  selectedPlayerId,
  onMarkerPress,
}: ManhuntMapProps) {
  const camera = useRef<CameraRef>(null);
  const [mapReady, setMapReady] = useState(false);
  const didInitializeCamera = useRef(false);
  const lastRecenterVersion = useRef(recenterVersion);
  const boundaryCircle = useMemo(
    () =>
      boundary
        ? createBoundaryCircleGeoJson(
            boundary.center,
            boundary.radiusMeters,
          )
        : null,
    [
      boundary?.center.latitude,
      boundary?.center.longitude,
      boundary?.radiusMeters,
    ],
  );
  const outerBoundaryCircle = useMemo(
    () =>
      boundary
        ? createBoundaryCircleGeoJson(
            boundary.center,
            boundary.radiusMeters +
              MANHUNT_OUTER_BOUNDARY_VISUAL_OFFSET_METERS,
          )
        : null,
    [
      boundary?.center.latitude,
      boundary?.center.longitude,
      boundary?.radiusMeters,
    ],
  );
  const missionCircleGeoJson = useMemo(
    () =>
      missionCircle
        ? createBoundaryCircleGeoJson(
            missionCircle.center,
            missionCircle.radiusMeters,
          )
        : null,
    [
      missionCircle?.center.latitude,
      missionCircle?.center.longitude,
      missionCircle?.radiusMeters,
    ],
  );
  const boundaryBounds = useMemo(
    () =>
      outerBoundaryCircle
        ? getBoundaryCircleBounds(outerBoundaryCircle)
        : null,
    [outerBoundaryCircle],
  );

  useEffect(() => {
    if (!mapReady) {
      return;
    }

    if (!didInitializeCamera.current) {
      if (boundaryBounds) {
        camera.current?.fitBounds(boundaryBounds, {
          duration: 0,
          padding: { top: 112, right: 40, bottom: 220, left: 40 },
        });
      } else if (location) {
        camera.current?.flyTo({
          center: [location.coords.longitude, location.coords.latitude],
          duration: 0,
        });
      } else {
        return;
      }

      didInitializeCamera.current = true;
      lastRecenterVersion.current = recenterVersion;
      return;
    }

    if (!location || lastRecenterVersion.current === recenterVersion) {
      return;
    }

    camera.current?.flyTo({
      center: [location.coords.longitude, location.coords.latitude],
      duration: 700,
    });
    lastRecenterVersion.current = recenterVersion;
  }, [boundaryBounds, location, mapReady, recenterVersion]);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={OPENFREEMAP_STYLE}
      attribution
      attributionPosition={{ bottom: 12, right: 12 }}
      logo
      logoPosition={{ bottom: 12, left: 12 }}
      compass={false}
      scaleBar={false}
      onDidFinishLoadingMap={() => {
        setMapReady(true);
        onMapReady();
      }}
      onDidFailLoadingMap={onMapError}
    >
      <Camera
        ref={camera}
        initialViewState={{
          center: boundary
            ? [boundary.center.longitude, boundary.center.latitude]
            : [0, 0],
          zoom: boundary ? 15 : 2,
        }}
        minZoom={2}
        maxZoom={20}
      />
      {boundary && boundaryCircle && outerBoundaryCircle ? (
        <GeoJSONSource
          id="manhunt-boundary"
          data={boundaryCircle}
        >
          <Layer
            id="manhunt-boundary-fill"
            type="fill"
            paint={{
              "fill-color": colors.pinkMap,
              "fill-opacity": 0.1,
            }}
          />
          <Layer
            id="manhunt-boundary-line"
            type="line"
            paint={{
              "line-color": colors.pinkMap,
              "line-width": 2,
              "line-opacity": 0.72,
            }}
          />
        </GeoJSONSource>
      ) : null}
      {boundary && outerBoundaryCircle ? (
        <GeoJSONSource
          id="manhunt-outer-boundary"
          data={outerBoundaryCircle}
        >
          <Layer
            id="manhunt-outer-boundary-line"
            type="line"
            paint={{
              "line-color": colors.pinkMap,
              "line-width": 1,
              "line-opacity": 0.5,
              "line-dasharray": [2, 2],
            }}
          />
        </GeoJSONSource>
      ) : null}
      {missionCircle && missionCircleGeoJson ? (
        <GeoJSONSource id="manhunt-own-mission" data={missionCircleGeoJson}>
          <Layer
            id="manhunt-own-mission-fill"
            type="fill"
            paint={{
              "fill-color": colors.gold,
              "fill-opacity": 0.18,
            }}
          />
          <Layer
            id="manhunt-own-mission-line"
            type="line"
            paint={{
              "line-color": colors.gold,
              "line-width": 3,
              "line-opacity": 0.96,
            }}
          />
        </GeoJSONSource>
      ) : null}
      {missionCircle ? (
        <Marker
          id="manhunt-own-mission-center"
          lngLat={[
            missionCircle.center.longitude,
            missionCircle.center.latitude,
          ]}
          anchor="center"
        >
          <View style={styles.missionMarker}>
            <Target color={colors.textOnAccent} size={19} strokeWidth={2.5} />
          </View>
        </Marker>
      ) : null}
      {location ? (
        <Marker
          id="device-location"
          lngLat={[location.coords.longitude, location.coords.latitude]}
          anchor="center"
        >
          <View style={styles.locationMarker}>
            <View style={styles.locationDot} />
          </View>
        </Marker>
      ) : null}
      {revealedLocations.map((revealed) => {
        const caught = caughtPlayerIds.includes(revealed.playerId) ||
          revealed.status === "caught";
        const selected = selectedPlayerId === revealed.playerId;
        return (
          <Marker
            key={revealed.playerId}
            id={`revealed-${revealed.playerId}`}
            lngLat={[
              revealed.coordinates.longitude,
              revealed.coordinates.latitude,
            ]}
            anchor="center"
            onPress={() => onMarkerPress?.(revealed.playerId)}
          >
            <View
              style={[
                styles.remoteMarker,
                caught ? styles.caughtMarker : null,
                selected ? styles.selectedMarker : null,
              ]}
            >
              <View style={styles.remoteMarkerDot} />
            </View>
          </Marker>
        );
      })}
      {decoyLocations.map((decoy) => (
        <Marker
          key={decoy.decoyId}
          id={`freeze-decoy-${decoy.decoyId}`}
          lngLat={[
            decoy.coordinates.longitude,
            decoy.coordinates.latitude,
          ]}
          anchor="center"
        >
          <View style={styles.remoteMarker}>
            <View style={styles.remoteMarkerDot} />
          </View>
        </Marker>
      ))}
      {lateGameClue ? (
        <Marker
          key={lateGameClue.clueId}
          id={`late-game-clue-${lateGameClue.clueId}`}
          lngLat={[
            lateGameClue.coordinates.longitude,
            lateGameClue.coordinates.latitude,
          ]}
          anchor="center"
        >
          <View style={styles.remoteMarker}>
            <View style={styles.remoteMarkerDot} />
          </View>
        </Marker>
      ) : null}
    </Map>
  );
}

const styles = StyleSheet.create({
  locationMarker: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderWidth: 1,
    borderColor: colors.text,
  },
  locationDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.teal,
    borderWidth: 2,
    borderColor: colors.textOnAccent,
  },
  missionMarker: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: colors.gold,
    borderWidth: 2,
    borderColor: colors.textOnAccent,
  },
  remoteMarker: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    borderWidth: 2,
    backgroundColor: "rgba(83, 96, 116, 0.92)",
    borderColor: colors.textMuted,
  },
  remoteMarkerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.textOnAccent,
  },
  caughtMarker: {
    opacity: 0.45,
  },
  selectedMarker: {
    borderWidth: 4,
    borderColor: colors.text,
  },
});
