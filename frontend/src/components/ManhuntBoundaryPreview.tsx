import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
} from "@maplibre/maplibre-react-native";
import type { CameraRef } from "@maplibre/maplibre-react-native";
import { LocateFixed, MapPin, RefreshCw } from "lucide-react-native";
import { manhuntBoundarySchema } from "@impostor/api";
import type { Coordinates } from "@impostor/api";
import { HudPanel } from "./HudPanel";
import { IconButton } from "./IconButton";
import { PrimaryButton } from "./PrimaryButton";
import { colors, spacing, typography } from "../theme";
import { useTranslation } from "../i18n/use-translation";
import {
  createBoundaryCircleGeoJson,
  getBoundaryCircleBounds,
  OPENFREEMAP_STYLE,
} from "../utils/manhunt-map";

interface ManhuntBoundaryPreviewProps {
  center: Coordinates | null;
  radiusMeters: number;
}

type MapStatus = "loading" | "ready" | "error";

export function ManhuntBoundaryPreview({
  center,
  radiusMeters,
}: ManhuntBoundaryPreviewProps) {
  const t = useTranslation();
  const camera = useRef<CameraRef>(null);
  const [mapStatus, setMapStatus] = useState<MapStatus>("loading");
  const [mapInstance, setMapInstance] = useState(0);
  const [recenterVersion, setRecenterVersion] = useState(0);
  const circle = useMemo(() => {
    const parsed = center
      ? manhuntBoundarySchema.safeParse({ center, radiusMeters })
      : null;
    return parsed?.success
      ? createBoundaryCircleGeoJson(
          parsed.data.center,
          parsed.data.radiusMeters,
        )
      : null;
  }, [center?.latitude, center?.longitude, radiusMeters]);
  const bounds = useMemo(
    () => (circle ? getBoundaryCircleBounds(circle) : null),
    [circle],
  );

  useEffect(() => {
    if (mapStatus !== "ready" || !center || !bounds) {
      return;
    }

    camera.current?.fitBounds(bounds, {
      duration: 500,
      padding: { top: 48, right: 48, bottom: 48, left: 48 },
    });
  }, [
    bounds,
    center?.latitude,
    center?.longitude,
    mapStatus,
    recenterVersion,
  ]);

  if (!circle || !center) {
    return (
      <View style={styles.placeholder}>
        <MapPin color={colors.textMuted} size={26} strokeWidth={1.8} />
        <Text style={styles.placeholderTitle}>
          {t("manhunt.preview.title")}
        </Text>
        <Text style={styles.placeholderText}>
          {t("manhunt.preview.description")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.mapFrame}>
      <Map
        key={mapInstance}
        style={StyleSheet.absoluteFill}
        mapStyle={OPENFREEMAP_STYLE}
        attribution
        attributionPosition={{ bottom: 12, right: 12 }}
        logo
        logoPosition={{ bottom: 12, left: 12 }}
        compass={false}
        scaleBar={false}
        onDidFinishLoadingMap={() => setMapStatus("ready")}
        onDidFailLoadingMap={() => setMapStatus("error")}
      >
        <Camera
          ref={camera}
          initialViewState={{
            center: [center.longitude, center.latitude],
            zoom: 15,
          }}
          minZoom={2}
          maxZoom={20}
        />
        <GeoJSONSource id="manhunt-boundary-preview" data={circle}>
          <Layer
            id="manhunt-boundary-preview-fill"
            type="fill"
            paint={{
              "fill-color": colors.mapBoundary,
              "fill-opacity": 0.16,
            }}
          />
          <Layer
            id="manhunt-boundary-preview-line"
            type="line"
            paint={{
              "line-color": colors.mapBoundary,
              "line-width": 3,
              "line-dasharray": [2, 2],
            }}
          />
        </GeoJSONSource>
        <Marker
          id="manhunt-boundary-preview-center"
          lngLat={[center.longitude, center.latitude]}
          anchor="center"
        >
          <View style={styles.centerMarker}>
            <View style={styles.centerMarkerDot} />
          </View>
        </Marker>
      </Map>

      {mapStatus === "loading" ? (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <HudPanel style={styles.statusPanel}>
            <ActivityIndicator color={colors.teal} />
            <Text style={styles.statusText}>
              {t("manhunt.preview.loading")}
            </Text>
          </HudPanel>
        </View>
      ) : null}

      {mapStatus === "error" ? (
        <View style={styles.errorOverlay}>
          <HudPanel style={styles.statusPanel}>
            <Text style={styles.errorTitle}>
              {t("manhunt.preview.unavailable")}
            </Text>
            <Text style={styles.statusText}>
              {t("manhunt.preview.error")}
            </Text>
            <PrimaryButton
              title={t("manhunt.preview.retry")}
              variant="secondary"
              leftIcon={RefreshCw}
              onPress={() => {
                setMapStatus("loading");
                setMapInstance((current) => current + 1);
              }}
            />
          </HudPanel>
        </View>
      ) : null}

      <IconButton
        icon={LocateFixed}
        accessibilityLabel={t("manhunt.preview.recenter")}
        disabled={mapStatus !== "ready"}
        onPress={() => setRecenterVersion((current) => current + 1)}
        style={styles.recenterButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    width: "100%",
    aspectRatio: 1.45,
    minHeight: 220,
    maxHeight: 340,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.panelRaised,
  },
  placeholderTitle: {
    ...typography.body,
    color: colors.text,
  },
  placeholderText: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: "center",
  },
  mapFrame: {
    width: "100%",
    aspectRatio: 1.45,
    minHeight: 220,
    maxHeight: 340,
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.mapBase,
  },
  centerMarker: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    borderWidth: 2,
    borderColor: colors.text,
    backgroundColor: colors.teal,
  },
  centerMarkerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.textOnAccent,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.md,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.md,
    backgroundColor: "rgba(11,12,17,0.82)",
  },
  statusPanel: {
    width: "100%",
    alignItems: "center",
    gap: spacing.md,
  },
  statusText: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: "center",
  },
  errorTitle: {
    ...typography.body,
    color: colors.text,
    textAlign: "center",
  },
  recenterButton: {
    position: "absolute",
    top: spacing.md,
    right: spacing.md,
  },
});
