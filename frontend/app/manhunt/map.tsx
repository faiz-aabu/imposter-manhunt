import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ArrowLeft,
  LocateFixed,
  RefreshCw,
  Settings,
  Target,
} from "lucide-react-native";
import { MANHUNT_EVENTS } from "@impostor/api";
import type {
  CatchConfirmationRequestPayload,
  CatchConfirmedPayload,
  CatchRequestStatusPayload,
  ManhuntProximityAlertPayload,
} from "@impostor/api";
import {
  CatchAnnouncementBanner,
  HudPanel,
  IconButton,
  MapBanner,
  ManhuntCatchConfirmationModal,
  ManhuntMap,
  PrimaryButton,
  TopHudBar,
} from "../../src/components";
import { useDeviceLocation } from "../../src/hooks/use-device-location";
import { useManhuntGameStore } from "../../src/store/manhunt-game-store";
import { useRoomStore } from "../../src/store/room-store";
import { getSocketClient } from "../../src/services/socket-client";
import { emitWithAcknowledgement } from "../../src/services/socket-requests";
import { colors, spacing, typography } from "../../src/theme";
import { ManhuntCatchAnnouncementQueue } from "../../src/utils/manhunt-catch-announcement-queue";
import { ManhuntProximityHapticGate } from "../../src/utils/manhunt-proximity-haptics";

type MapLoadStatus = "loading" | "ready" | "error";

export default function MapRoute() {
  const router = useRouter();
  const location = useDeviceLocation();
  const manhunt = useManhuntGameStore();
  const room = useRoomStore((state) => state.room);
  const [mapStatus, setMapStatus] = useState<MapLoadStatus>("loading");
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapInstance, setMapInstance] = useState(0);
  const [recenterVersion, setRecenterVersion] = useState(0);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const [incomingCatchRequest, setIncomingCatchRequest] =
    useState<CatchConfirmationRequestPayload | null>(null);
  const [catchResponseBusy, setCatchResponseBusy] = useState(false);
  const [catchResponseError, setCatchResponseError] = useState<string | null>(
    null,
  );
  const [catchAnnouncement, setCatchAnnouncement] =
    useState<CatchConfirmedPayload | null>(null);
  const catchResponseBusyRef = useRef(false);
  const lastLocationSentAt = useRef(0);

  const active =
    manhunt.session !== null &&
    manhunt.gameState?.phase === "active";
  const boundary = manhunt.gameState?.settings.boundary ??
    manhunt.session?.state.settings.boundary ??
    null;

  useEffect(() => {
    if (!active || !location.location || !room || !manhunt.session) {
      return;
    }
    const now = Date.now();
    if (now - lastLocationSentAt.current < 5_000) {
      return;
    }
    lastLocationSentAt.current = now;
    void emitWithAcknowledgement({
      event: MANHUNT_EVENTS.LOCATION_UPDATE,
      payload: {
        roomCode: room.code,
        coordinates: {
          latitude: location.location.coords.latitude,
          longitude: location.location.coords.longitude,
        },
        accuracyMeters:
          typeof location.location.coords.accuracy === "number"
            ? location.location.coords.accuracy
            : undefined,
        clientTimestamp: new Date(location.location.timestamp).toISOString(),
      },
    }).catch(() => undefined);
  }, [active, location.location, manhunt.session, room]);

  useEffect(() => {
    if (!active) {
      setSelectedPlayerId(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const socket = getSocketClient();
    const onDisconnect = () => {
      useManhuntGameStore.getState().clearReveal();
      setSelectedPlayerId(null);
      setIncomingCatchRequest(null);
    };
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("disconnect", onDisconnect);
      useManhuntGameStore.getState().clearReveal();
      setSelectedPlayerId(null);
    };
  }, [active]);

  useEffect(() => {
    if (!active || !room || !manhunt.session) {
      return;
    }

    const socket = getSocketClient();
    const sessionId = manhunt.session.id;
    const queue = new ManhuntCatchAnnouncementQueue(setCatchAnnouncement);
    const hapticGate = new ManhuntProximityHapticGate();

    const onCatchConfirmationRequest = (
      payload: CatchConfirmationRequestPayload,
    ) => {
      if (
        payload.roomCode !== room.code ||
        payload.sessionId !== sessionId ||
        manhunt.ownTeam !== "runner"
      ) {
        return;
      }
      setCatchResponseError(null);
      setIncomingCatchRequest(payload);
    };
    const onCatchRequestStatus = (payload: CatchRequestStatusPayload) => {
      if (payload.roomCode !== room.code || payload.sessionId !== sessionId) {
        return;
      }
      useManhuntGameStore.getState().setCatchRequestStatus(payload);
      if (payload.status !== "pending") {
        setIncomingCatchRequest((current) =>
          current?.requestId === payload.requestId ? null : current,
        );
      }
    };
    const onCatchConfirmed = (payload: CatchConfirmedPayload) => {
      if (payload.roomCode === room.code && payload.sessionId === sessionId) {
        queue.enqueue(payload);
      }
    };
    const onProximityAlert = (payload: ManhuntProximityAlertPayload) => {
      const currentGame = useManhuntGameStore.getState();
      if (
        payload.roomCode !== room.code ||
        payload.sessionId !== sessionId ||
        currentGame.gameState?.phase !== "active" ||
        !currentGame.ownTeam ||
        !hapticGate.shouldTrigger(payload.level)
      ) {
        return;
      }
      void Haptics.impactAsync(
        payload.level === "very_near"
          ? Haptics.ImpactFeedbackStyle.Heavy
          : Haptics.ImpactFeedbackStyle.Light,
      ).catch((error: unknown) => {
        console.warn("Manhunt proximity haptic failed.", error);
      });
    };
    const onSocketDisconnect = () => hapticGate.reset();

    socket.on("disconnect", onSocketDisconnect);
    socket.on(
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
      onCatchConfirmationRequest,
    );
    socket.on(MANHUNT_EVENTS.CATCH_REQUEST_STATUS, onCatchRequestStatus);
    socket.on(MANHUNT_EVENTS.CATCH_CONFIRMED, onCatchConfirmed);
    socket.on(MANHUNT_EVENTS.PROXIMITY_ALERT, onProximityAlert);

    return () => {
      socket.off("disconnect", onSocketDisconnect);
      socket.off(
        MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
        onCatchConfirmationRequest,
      );
      socket.off(MANHUNT_EVENTS.CATCH_REQUEST_STATUS, onCatchRequestStatus);
      socket.off(MANHUNT_EVENTS.CATCH_CONFIRMED, onCatchConfirmed);
      socket.off(MANHUNT_EVENTS.PROXIMITY_ALERT, onProximityAlert);
      queue.dispose();
      hapticGate.reset();
      setIncomingCatchRequest(null);
      setCatchAnnouncement(null);
    };
  }, [active, manhunt.ownTeam, manhunt.session?.id, room?.code]);

  useEffect(() => {
    if (!incomingCatchRequest) {
      return;
    }
    const remainingMs = Math.max(
      0,
      Date.parse(incomingCatchRequest.expiresAt) - Date.now(),
    );
    const timer = setTimeout(() => {
      setIncomingCatchRequest((current) =>
        current?.requestId === incomingCatchRequest.requestId ? null : current,
      );
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [incomingCatchRequest?.requestId]);

  useEffect(() => {
    if (!active && !manhunt.reveal) return;
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active, manhunt.reveal?.visibleUntil]);

  const revealVisibleUntil = manhunt.reveal
    ? Date.parse(manhunt.reveal.visibleUntil)
    : 0;
  const now = Math.max(clockNow, Date.now());
  const visibleRevealRemaining = Number.isFinite(revealVisibleUntil)
    ? Math.max(0, Math.ceil((revealVisibleUntil - now) / 1_000))
    : 0;
  const revealActive = revealVisibleUntil > now;
  const revealLocations = revealActive
    ? manhunt.reveal?.locations ?? []
    : [];
  const formattedRevealTime = `00:${String(visibleRevealRemaining).padStart(2, "0")}`;
  const gameEndsAt = manhunt.gameState?.gameEndsAt ? Date.parse(manhunt.gameState.gameEndsAt) : 0;
  const gameRemainingSeconds = gameEndsAt > 0 ? Math.max(0, Math.ceil((gameEndsAt - now) / 1_000)) : 0;
  const formattedGameTime = `${String(Math.floor(gameRemainingSeconds / 60)).padStart(2, "0")}:${String(gameRemainingSeconds % 60).padStart(2, "0")}`;
  const shrinkWarningEndsAt = manhunt.gameState?.shrinkWarningEndsAt ? Date.parse(manhunt.gameState.shrinkWarningEndsAt) : 0;
  const shrinkCountdownRemaining = shrinkWarningEndsAt > now
    ? Math.max(0, Math.ceil((shrinkWarningEndsAt - now) / 1_000))
    : 0;

  const attemptCatch = () => {
    if (
      !selectedPlayerId ||
      manhunt.catchPending ||
      manhunt.ownTeam !== "hunter" ||
      !room
    ) {
      return;
    }
    const target = revealLocations.find(
      (entry) => entry.playerId === selectedPlayerId,
    );
    if (!target || target.team !== "runner" ||
      target.status === "caught" ||
      manhunt.caughtPlayerIds.includes(target.playerId)) {
      useManhuntGameStore
        .getState()
        .setError("That runner is no longer available.");
      return;
    }
    manhunt.setCatchPending(true);
    manhunt.setCatchRequestStatus(null);
    useManhuntGameStore.getState().setError(null);
    try {
      getSocketClient().emit(MANHUNT_EVENTS.CATCH, {
        roomCode: room.code,
        targetPlayerId: selectedPlayerId,
      });
    } catch (error) {
      manhunt.setCatchPending(false);
      manhunt.setError(
        error instanceof Error
          ? error.message
          : "Could not submit the catch.",
      );
    }
  };

  const respondToCatch = async (accepted: boolean) => {
    if (
      !incomingCatchRequest ||
      !room ||
      catchResponseBusyRef.current
    ) {
      return;
    }
    catchResponseBusyRef.current = true;
    setCatchResponseBusy(true);
    setCatchResponseError(null);
    try {
      const response = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE,
        payload: {
          roomCode: room.code,
          requestId: incomingCatchRequest.requestId,
          accepted,
        },
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      setIncomingCatchRequest(null);
    } catch (error) {
      setCatchResponseError(
        error instanceof Error
          ? error.message
          : "Could not send your catch response.",
      );
    } finally {
      catchResponseBusyRef.current = false;
      setCatchResponseBusy(false);
    }
  };

  useEffect(() => {
    if (!manhunt.error) return;
    manhunt.setCatchPending(false);
  }, [manhunt.error]);

  return (
    <View style={styles.screen}>
      <ManhuntMap
        key={mapInstance}
        location={location.location}
        recenterVersion={recenterVersion}
        boundary={boundary}
        revealedLocations={revealLocations}
        caughtPlayerIds={manhunt.caughtPlayerIds}
        selectedPlayerId={selectedPlayerId}
        onMarkerPress={(playerId) => {
          if (manhunt.ownTeam !== "hunter") return;
          setSelectedPlayerId(playerId);
        }}
        onMapReady={() => {
          setMapError(null);
          setMapStatus("ready");
        }}
        onMapError={() => {
          setMapError("The map could not be loaded.");
          setMapStatus("error");
        }}
      />

      <SafeAreaView
        edges={["top", "bottom"]}
        pointerEvents="box-none"
        style={styles.overlay}
      >
        <View style={styles.topContent}>
          <TopHudBar
            style={styles.topHud}
            leftLabel="Manhunt"
            leftValue={manhunt.ownTeam ? manhunt.ownTeam.toUpperCase() : "TEAM"}
            rightLabel="Game"
            rightValue={formattedGameTime}
          />
          {shrinkCountdownRemaining > 0 ? (
            <MapBanner
              message="Safe zone shrinking in"
              timer={`${shrinkCountdownRemaining}s`}
              style={styles.revealBanner}
            />
          ) : null}
          {revealActive ? (
            <MapBanner
              message="Location reveal active"
              timer={formattedRevealTime}
              style={styles.revealBanner}
            />
          ) : null}
          {catchAnnouncement ? (
            <CatchAnnouncementBanner announcement={catchAnnouncement} />
          ) : null}
        </View>

        {mapStatus === "loading" ? (
          <View pointerEvents="none" style={styles.mapLoading}>
            <ActivityIndicator color={colors.teal} />
            <Text style={styles.mapLoadingText}>Loading map...</Text>
          </View>
        ) : null}

        <View style={styles.bottomContent}>
          {mapStatus === "error" ? (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusTitle}>Map unavailable</Text>
              <Text style={styles.statusMessage}>{mapError}</Text>
              <PrimaryButton
                title="Retry map"
                leftIcon={RefreshCw}
                onPress={() => {
                  setMapError(null);
                  setMapStatus("loading");
                  setMapInstance((current) => current + 1);
                }}
              />
            </HudPanel>
          ) : null}

          {manhunt.error ? (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusMessage}>{manhunt.error}</Text>
            </HudPanel>
          ) : null}

          {manhunt.ownTeam === "hunter" &&
          manhunt.catchRequestStatus?.status ? (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusMessage}>
                {catchRequestStatusMessage(manhunt.catchRequestStatus.status)}
              </Text>
            </HudPanel>
          ) : null}

          {manhunt.ownTeam === "hunter" ? (
            <View style={styles.catchAction}>
              <PrimaryButton
                title={
                  manhunt.catchPending
                    ? "Waiting for runner confirmation"
                    : selectedPlayerId
                      ? "Request catch confirmation"
                      : "Select a runner marker"
                }
                leftIcon={Target}
                loading={manhunt.catchPending}
                disabled={
                  !selectedPlayerId ||
                  manhunt.catchPending ||
                  !revealActive
                }
                onPress={attemptCatch}
              />
              <Text style={styles.catchHint}>
                Catch requests require 1.5 m proximity and runner confirmation.
              </Text>
            </View>
          ) : (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusTitle}>Runner</Text>
              <Text style={styles.statusMessage}>
                Your location is private except during server reveal windows.
              </Text>
            </HudPanel>
          )}

          <PrimaryButton
            title="Freeze unavailable"
            variant="secondary"
            disabled
            onPress={() => undefined}
          />

          <View style={styles.mapControls}>
            <IconButton
              icon={ArrowLeft}
              accessibilityLabel="Back"
              onPress={() => router.back()}
            />
            <IconButton
              icon={LocateFixed}
              accessibilityLabel="Recenter"
              disabled={!location.location || mapStatus !== "ready"}
              iconColor={colors.teal}
              onPress={() => setRecenterVersion((value) => value + 1)}
            />
            <IconButton
              icon={Settings}
              accessibilityLabel="Location settings"
              onPress={() => void location.openAppSettings()}
            />
          </View>
        </View>
      </SafeAreaView>
      <ManhuntCatchConfirmationModal
        request={incomingCatchRequest}
        busy={catchResponseBusy}
        error={catchResponseError}
        onAccept={() => void respondToCatch(true)}
        onReject={() => void respondToCatch(false)}
      />
    </View>
  );
}

function catchRequestStatusMessage(
  status: NonNullable<
    ReturnType<typeof useManhuntGameStore.getState>["catchRequestStatus"]
  >["status"],
): string {
  switch (status) {
    case "pending":
      return "Waiting for the runner to confirm the catch.";
    case "rejected":
      return "The runner rejected the catch request.";
    case "expired":
      return "The catch request expired without a catch.";
    case "cancelled":
      return "The catch request was cancelled.";
    case "accepted":
      return "The runner accepted the catch.";
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
  },
  topContent: {
    gap: spacing.sm,
  },
  topHud: {
    marginHorizontal: spacing.md,
  },
  revealBanner: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  mapLoading: {
    alignSelf: "center",
    marginTop: spacing.xxl,
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  mapLoadingText: {
    ...typography.small,
    color: colors.text,
  },
  bottomContent: {
    gap: spacing.sm,
    padding: spacing.md,
  },
  statusPanel: {
    gap: spacing.sm,
  },
  catchAction: {
    gap: spacing.xs,
  },
  catchHint: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: "center",
  },
  statusTitle: {
    ...typography.body,
    color: colors.text,
  },
  statusMessage: {
    ...typography.small,
    color: colors.textMuted,
  },
  mapControls: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
});
