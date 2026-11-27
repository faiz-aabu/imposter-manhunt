import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, LocateFixed, Minus, Plus } from "lucide-react-native";
import { useRouter } from "expo-router";
import {
  coordinatesSchema,
  MANHUNT_LOCATION_REVEAL_DURATION_SECONDS,
  MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS,
  MAX_MANHUNT_BOUNDARY_RADIUS_METERS,
  MIN_MANHUNT_BOUNDARY_RADIUS_METERS,
  MANHUNT_GAME_DURATION_OPTIONS_SECONDS,
  DEFAULT_MANHUNT_GAME_DURATION_SECONDS,
  MIN_MANHUNT_HUNTERS,
  manhuntSettingsSchema,
  MANHUNT_EVENTS,
  ROOM_EVENTS,
  ERROR_EVENTS,
  GAME_EVENTS,
} from "@impostor/api";
import type {
  ManhuntReadyUpdatePayload,
  ManhuntSettings,
  RoomUpdatePayload,
  ServerErrorPayload,
  ValidationErrorPayload,
} from "@impostor/api";
import {
  HudPanel,
  IconButton,
  ManhuntBoundaryPreview,
  PlayerRow,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../../src/components";
import { useRoomStore } from "../../src/store/room-store";
import { useConnectionStore } from "../../src/store/connection-store";
import { getSocketClient } from "../../src/services/socket-client";
import { emitWithAcknowledgement } from "../../src/services/socket-requests";
import { useDeviceLocation } from "../../src/hooks/use-device-location";
import { localizeManhuntError } from "../../src/i18n/manhunt-errors";
import { useTranslation } from "../../src/i18n/use-translation";
import { colors, radii, spacing, typography } from "../../src/theme";

function clampRadiusMeters(radiusMeters: number) {
  if (!Number.isFinite(radiusMeters)) {
    return MIN_MANHUNT_BOUNDARY_RADIUS_METERS;
  }
  return Math.min(
    MAX_MANHUNT_BOUNDARY_RADIUS_METERS,
    Math.max(MIN_MANHUNT_BOUNDARY_RADIUS_METERS, radiusMeters),
  );
}

export default function SetupRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const playerId = useRoomStore((state) => state.playerId);
  const setRoom = useRoomStore((state) => state.setRoom);
  const manhuntBoundaryRoomCode = useRoomStore(
    (state) => state.manhuntBoundaryRoomCode,
  );
  const manhuntBoundary = useRoomStore((state) => state.manhuntBoundary);
  const connectionStatus = useConnectionStore((state) => state.status);
  const location = useDeviceLocation();
  const [hunterCount, setHunterCount] = useState(
    room?.settings.manhunt?.hunterCount ?? MIN_MANHUNT_HUNTERS,
  );
  const [gameDurationSeconds, setGameDurationSeconds] = useState<1_800 | 2_700 | 3_600>(
    room?.settings.manhunt?.gameDurationSeconds ?? DEFAULT_MANHUNT_GAME_DURATION_SECONDS,
  );
  const [radiusMeters, setRadiusMeters] = useState(
    clampRadiusMeters(
      manhuntBoundaryRoomCode === room?.code
        ? manhuntBoundary?.radiusMeters ?? MIN_MANHUNT_BOUNDARY_RADIUS_METERS
        : MIN_MANHUNT_BOUNDARY_RADIUS_METERS,
    ),
  );
  const [center, setCenter] = useState(
    manhuntBoundaryRoomCode === room?.code ? manhuntBoundary?.center ?? null : null,
  );
  const [ready, setReady] = useState(false);
  const [readyPlayerIds, setReadyPlayerIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!room) return;
    setHunterCount(room.settings.manhunt?.hunterCount ?? MIN_MANHUNT_HUNTERS);
    setGameDurationSeconds(room.settings.manhunt?.gameDurationSeconds ?? DEFAULT_MANHUNT_GAME_DURATION_SECONDS);
    setRadiusMeters(
      clampRadiusMeters(
        manhuntBoundaryRoomCode === room.code
          ? manhuntBoundary?.radiusMeters ?? MIN_MANHUNT_BOUNDARY_RADIUS_METERS
          : MIN_MANHUNT_BOUNDARY_RADIUS_METERS,
      ),
    );
    setCenter(
      manhuntBoundaryRoomCode === room.code
        ? manhuntBoundary?.center ?? null
        : null,
    );
  }, [room?.code, room?.settings.manhunt, manhuntBoundaryRoomCode, manhuntBoundary]);

  useEffect(() => {
    let socket: ReturnType<typeof getSocketClient>;
    try {
      socket = getSocketClient();
    } catch {
      return;
    }
    const settingsUpdated = (payload: { roomCode: string; settings: import("@impostor/api").ManhuntPublicSettings }) => {
      if (payload.roomCode !== room?.code) return;
      setHunterCount(payload.settings.hunterCount);
      setGameDurationSeconds(payload.settings.gameDurationSeconds ?? DEFAULT_MANHUNT_GAME_DURATION_SECONDS);
      setError(null);
    };
    const roomUpdated = (payload: RoomUpdatePayload) => {
      if (payload.room.code === room?.code) setRoom(payload.room);
    };
    const readyUpdated = (payload: ManhuntReadyUpdatePayload) => {
      if (payload.roomCode === room?.code) {
        setReadyPlayerIds(payload.readyPlayerIds ?? []);
      }
    };
    const serverError = (payload: ServerErrorPayload) => setError(payload.message);
    const validationError = (payload: ValidationErrorPayload) => setError(payload.message);

    socket.on(MANHUNT_EVENTS.SETTINGS_UPDATE, settingsUpdated);
    socket.on(ROOM_EVENTS.UPDATE, roomUpdated);
    socket.on(MANHUNT_EVENTS.READY_UPDATE, readyUpdated);
    socket.on(ERROR_EVENTS.SERVER_ERROR, serverError);
    socket.on(ERROR_EVENTS.VALIDATION_ERROR, validationError);
    return () => {
      socket.off(MANHUNT_EVENTS.SETTINGS_UPDATE, settingsUpdated);
      socket.off(ROOM_EVENTS.UPDATE, roomUpdated);
      socket.off(MANHUNT_EVENTS.READY_UPDATE, readyUpdated);
      socket.off(ERROR_EVENTS.SERVER_ERROR, serverError);
      socket.off(ERROR_EVENTS.VALIDATION_ERROR, validationError);
    };
  }, [room?.code, setRoom]);

  const isHost = room?.hostId === playerId;
  const connectedCount = room?.players.filter(
    (player) => player.connectionStatus === "connected",
  ).length ?? 0;
  const hunterMaximum = Math.max(
    MIN_MANHUNT_HUNTERS,
    (room?.players.length ?? 0) - 1,
  );
  const settings = useMemo<ManhuntSettings | null>(
    () =>
      center
        ? {
            hunterCount,
            gameDurationSeconds,
            boundary: {
              center: {
                latitude: center.latitude,
                longitude: center.longitude,
              },
              radiusMeters,
            },
          }
        : null,
    [center, gameDurationSeconds, hunterCount, radiusMeters],
  );
  const settingsValid =
    settings !== null && manhuntSettingsSchema.safeParse(settings).success;
  const currentCoordinates = useMemo(() => {
    if (!location.location) return null;
    const parsed = coordinatesSchema.safeParse({
      latitude: location.location.coords.latitude,
      longitude: location.location.coords.longitude,
    });
    return parsed.success ? parsed.data : null;
  }, [location.location]);
  const isLocationBusy = [
    "loading",
    "requesting-permission",
    "locating",
  ].includes(location.status);
  const locationMessage = (() => {
    switch (location.status) {
      case "loading":
        return t("manhunt.setup.location.checking");
      case "requesting-permission":
        return t("manhunt.setup.location.requesting");
      case "locating":
        return t("manhunt.setup.location.searching");
      case "ready":
        return currentCoordinates
          ? t("manhunt.setup.location.available")
          : t("manhunt.setup.location.invalid");
      case "permission-denied":
        return location.permissionCanAskAgain
          ? t("manhunt.setup.location.permission")
          : t("manhunt.setup.location.permissionSettings");
      case "services-disabled":
        return t("manhunt.setup.location.servicesDisabled");
      case "unavailable":
        return localizeManhuntError(location.error, t) ??
          t("manhunt.setup.location.unavailable");
      case "error":
        return location.error
          ? t("manhunt.setup.location.retrievalFailedDetail", {
              detail:
                localizeManhuntError(location.error, t) ?? location.error,
            })
          : t("manhunt.setup.location.retrievalFailed");
    }
  })();
  const locationAction = (() => {
    if (location.status === "permission-denied") {
      return location.permissionCanAskAgain
        ? {
            title: t("manhunt.setup.location.requestAgain"),
            onPress: location.retry,
          }
        : {
            title: t("manhunt.setup.location.openSettings"),
            onPress: location.openAppSettings,
          };
    }
    if (isLocationBusy) return null;
    if (location.status === "ready" && currentCoordinates) {
      return {
        title: t("manhunt.setup.location.refresh"),
        onPress: location.retry,
      };
    }
    return {
      title: t("manhunt.setup.location.retry"),
      onPress: location.retry,
    };
  })();
  const canStart =
    Boolean(isHost) &&
    connectionStatus === "connected" &&
    room?.gameStatus === "waiting" &&
    (room?.players.length ?? 0) >= 2 &&
    connectedCount === room?.players.length &&
    settingsValid &&
    hunterCount < (room?.players.length ?? 0);

  if (!room || !playerId) {
    return (
      <Screen>
        <Text style={styles.title}>{t("manhunt.mode.unavailable")}</Text>
      </Screen>
    );
  }

  const submitSettings = async () => {
    if (!isHost || isSubmitting || !settings) return;
    const parsed = manhuntSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      setError("Choose a valid play-area center and radius.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.UPDATE_SETTINGS,
        payload: { roomCode: room.code, settings: parsed.data },
      });
      if (!response.ok) throw new Error(response.error.message);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not update Manhunt settings.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleReady = () => {
    const nextReady = !ready;
    try {
      getSocketClient().emit(MANHUNT_EVENTS.READY_UPDATE, {
        roomCode: room.code,
        ready: nextReady,
      });
      setReady(nextReady);
    } catch {
      setError("Could not update readiness.");
    }
  };

  const startGame = async () => {
    if (isStarting || !canStart) return;
    setIsStarting(true);
    setError(null);
    try {
      const settingsResponse = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.UPDATE_SETTINGS,
        payload: { roomCode: room.code, settings: settings! },
      });
      if (!settingsResponse.ok) {
        throw new Error(settingsResponse.error.message);
      }
      const started = await emitWithAcknowledgement({
        event: GAME_EVENTS.START_GAME,
        payload: { roomCode: room.code },
      });
      if (!started.ok) throw new Error(started.error.message);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The game could not be started.",
      );
    } finally {
      setIsStarting(false);
    }
  };

  const useCurrentCenter = () => {
    if (!currentCoordinates) {
      setError("A valid GPS position is not available yet. Retry location and try again.");
      return;
    }
    setError(null);
    setCenter(currentCoordinates);
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <SafeAreaView edges={["top"]}>
        <View style={styles.header}>
          <IconButton
            icon={ArrowLeft}
            accessibilityLabel={t("manhunt.common.back")}
            onPress={() => router.back()}
          />
          <TopHudBar
            leftLabel={t("common.roomCode")}
            leftValue={room.code}
            rightLabel={t("common.players")}
            rightValue={`${room.players.length} / ${room.settings.maxPlayers}`}
          />
        </View>
        <Text style={styles.title}>{t("manhunt.setup.title")}</Text>

        <HudPanel style={styles.panel}>
          <Text style={styles.sectionTitle}>{t("manhunt.setup.hunters")}</Text>
          <View style={styles.stepper}>
            <Text style={styles.valueText}>{hunterCount}</Text>
            <View style={styles.stepperControls}>
              <IconButton
                icon={Minus}
                accessibilityLabel={t("manhunt.setup.decreaseHunters")}
                disabled={!isHost || hunterCount <= MIN_MANHUNT_HUNTERS}
                onPress={() => {
                  setHunterCount((value) => Math.max(MIN_MANHUNT_HUNTERS, value - 1));
                  setError(null);
                }}
              />
              <IconButton
                icon={Plus}
                accessibilityLabel={t("manhunt.setup.increaseHunters")}
                disabled={!isHost || hunterCount >= hunterMaximum}
                onPress={() => {
                  setHunterCount((value) => Math.min(hunterMaximum, value + 1));
                  setError(null);
                }}
              />
            </View>
          </View>
        </HudPanel>

        <HudPanel style={styles.panel}>
          <View style={styles.locationStatus}>
            {isLocationBusy ? (
              <ActivityIndicator color={colors.teal} />
            ) : null}
            <View style={styles.locationStatusText}>
              <Text style={styles.sectionTitle}>
                {t("manhunt.setup.currentLocation")}
              </Text>
              <Text accessibilityLiveRegion="polite" style={styles.mutedText}>
                {locationMessage}
              </Text>
            </View>
          </View>
          {locationAction ? (
            <PrimaryButton
              title={locationAction.title}
              variant="secondary"
              onPress={() => {
                setError(null);
                void locationAction.onPress();
              }}
            />
          ) : null}
        </HudPanel>

        <HudPanel style={styles.panel}>
          <Text style={styles.sectionTitle}>
            {t("manhunt.setup.duration")}
          </Text>
          <View style={styles.stepperControls}>
            {MANHUNT_GAME_DURATION_OPTIONS_SECONDS.map((duration) => (
              <PrimaryButton
                key={duration}
                title={t("manhunt.setup.durationOption", {
                  minutes: duration / 60,
                })}
                variant={gameDurationSeconds === duration ? "green" : "secondary"}
                disabled={!isHost}
                onPress={() => setGameDurationSeconds(duration)}
              />
            ))}
          </View>
          <Text style={styles.mutedText}>
            {t("manhunt.setup.durationExplanation")}
          </Text>
        </HudPanel>

        <HudPanel style={styles.panel}>
          <Text style={styles.sectionTitle}>{t("manhunt.setup.playArea")}</Text>
          <PrimaryButton
            title={t(
              center
                ? "manhunt.setup.updateGps"
                : "manhunt.setup.useGps",
            )}
            variant="secondary"
            leftIcon={LocateFixed}
            disabled={!isHost}
            onPress={useCurrentCenter}
          />
          {center ? (
            <Text style={styles.mutedText}>
              {t("manhunt.setup.center", {
                latitude: center.latitude.toFixed(5),
                longitude: center.longitude.toFixed(5),
              })}
            </Text>
          ) : (
            <Text style={styles.mutedText}>
              {t("manhunt.setup.noCenter")}
            </Text>
          )}
          <Text style={styles.sectionTitle}>
            {t("manhunt.setup.radius", { radius: radiusMeters })}
          </Text>
          <View style={styles.stepper}>
            <View style={styles.stepperControls}>
              <IconButton
                icon={Minus}
                accessibilityLabel={t("manhunt.setup.decreaseRadius")}
                disabled={!isHost || radiusMeters <= MIN_MANHUNT_BOUNDARY_RADIUS_METERS}
                onPress={() => setRadiusMeters((value) =>
                  Math.max(MIN_MANHUNT_BOUNDARY_RADIUS_METERS, value - 100),
                )}
              />
              <IconButton
                icon={Plus}
                accessibilityLabel={t("manhunt.setup.increaseRadius")}
                disabled={!isHost || radiusMeters >= MAX_MANHUNT_BOUNDARY_RADIUS_METERS}
                onPress={() => setRadiusMeters((value) =>
                  Math.min(MAX_MANHUNT_BOUNDARY_RADIUS_METERS, value + 100),
                )}
              />
            </View>
          </View>
          <ManhuntBoundaryPreview
            center={center}
            radiusMeters={radiusMeters}
          />
          {isHost ? (
            <PrimaryButton
              title={t("manhunt.setup.confirmSettings")}
              loading={isSubmitting}
              disabled={!settingsValid}
              onPress={() => void submitSettings()}
            />
          ) : null}
        </HudPanel>

        <HudPanel style={styles.panel}>
          <Text style={styles.sectionTitle}>{t("manhunt.setup.players")}</Text>
          {room.players.map((player) => (
            <PlayerRow
              key={player.id}
              name={player.nickname}
              chip={
                room.hostId === player.id
                  ? { label: t("manhunt.setup.host"), variant: "gold" }
                  : undefined
              }
              status={
                readyPlayerIds.includes(player.id)
                  ? t("manhunt.setup.ready")
                  : t("manhunt.setup.notReady")
              }
            />
          ))}
        </HudPanel>

        {error ? (
          <Text style={styles.errorText}>
            {localizeManhuntError(error, t) ?? error}
          </Text>
        ) : null}
        <PrimaryButton
          title={
            ready
              ? t("manhunt.setup.ready")
              : t("manhunt.setup.markReady")
          }
          variant={ready ? "green" : "secondary"}
          onPress={toggleReady}
        />
        {isHost ? (
          <PrimaryButton
            title={t("manhunt.setup.start")}
            loading={isStarting}
            disabled={!canStart || isStarting}
            onPress={() => void startGame()}
          />
        ) : (
          <Text style={styles.mutedText}>
            {t("manhunt.setup.hostOnlyStart")}
          </Text>
        )}
        <Text style={styles.mutedText}>
          {t("manhunt.setup.reveals", {
            interval: MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS,
            duration: MANHUNT_LOCATION_REVEAL_DURATION_SECONDS,
          })}
        </Text>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  panel: {
    gap: spacing.md,
  },
  sectionTitle: {
    ...typography.body,
    color: colors.text,
  },
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
  },
  errorText: {
    ...typography.small,
    color: colors.pink,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepperControls: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  locationStatus: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  locationStatusText: {
    flex: 1,
    gap: spacing.xs,
  },
  valueText: {
    ...typography.title,
    color: colors.teal,
  },
});
