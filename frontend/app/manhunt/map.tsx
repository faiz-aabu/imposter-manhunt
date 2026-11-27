import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import {
  ArrowLeft,
  LocateFixed,
  Navigation,
  RefreshCw,
  Settings,
  Target,
} from "lucide-react-native";
import {
  MANHUNT_EVENTS,
  MANHUNT_FREEZE_DECOY_DURATION_SECONDS,
  MANHUNT_GHOST_DURATION_SECONDS,
  MANHUNT_MISSION_DWELL_SECONDS,
  MANHUNT_SMOKE_BOMB_DURATION_SECONDS,
} from "@impostor/api";
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
import { localizeManhuntError } from "../../src/i18n/manhunt-errors";
import { useTranslation } from "../../src/i18n/use-translation";
import { getSocketClient } from "../../src/services/socket-client";
import { scheduleServerDeadline } from "../../src/services/server-clock-sync";
import { emitWithAcknowledgement } from "../../src/services/socket-requests";
import { colors, spacing, typography } from "../../src/theme";
import { ManhuntCatchAnnouncementQueue } from "../../src/utils/manhunt-catch-announcement-queue";
import { ManhuntProximityHapticGate } from "../../src/utils/manhunt-proximity-haptics";
import {
  EMPTY_MISSION_PROGRESS,
  formatMissionCountdown,
  getMissionProgressSeconds,
  getMissionRevealMessage,
  getVisibleMissionAssignment,
  isMissionCircleVisible,
  updateMissionProgress,
} from "../../src/utils/manhunt-missions";
import type { MissionProgressState } from "../../src/utils/manhunt-missions";
import { getVisibleFreezeDecoys } from "../../src/utils/manhunt-decoys";
import {
  getVisibleLateGameClue,
  getVisibleLateGameWarning,
} from "../../src/utils/manhunt-late-game-exposure";

type MapLoadStatus = "loading" | "ready" | "error";

export default function MapRoute() {
  const router = useRouter();
  const t = useTranslation();
  const location = useDeviceLocation();
  const manhunt = useManhuntGameStore();
  const room = useRoomStore((state) => state.room);
  const playerId = useRoomStore((state) => state.playerId);
  const manhuntBoundaryRoomCode = useRoomStore(
    (state) => state.manhuntBoundaryRoomCode,
  );
  const manhuntBoundary = useRoomStore((state) => state.manhuntBoundary);
  const [mapStatus, setMapStatus] = useState<MapLoadStatus>("loading");
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapInstance, setMapInstance] = useState(0);
  const [recenterVersion, setRecenterVersion] = useState(0);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const [incomingCatchRequest, setIncomingCatchRequest] =
    useState<CatchConfirmationRequestPayload | null>(null);
  const [catchResponseBusy, setCatchResponseBusy] = useState(false);
  const [footstepsPending, setFootstepsPending] = useState(false);
  const [smokeBombPending, setSmokeBombPending] = useState(false);
  const [ghostPending, setGhostPending] = useState(false);
  const [freezeDecoyPending, setFreezeDecoyPending] = useState(false);
  const [catchResponseError, setCatchResponseError] = useState<string | null>(
    null,
  );
  const [catchAnnouncement, setCatchAnnouncement] =
    useState<CatchConfirmedPayload | null>(null);
  const [missionProgress, setMissionProgress] =
    useState<MissionProgressState>(EMPTY_MISSION_PROGRESS);
  const serverTimeOffsetMs = useManhuntGameStore(
    (state) => state.serverTimeOffsetMs,
  );
  const catchResponseBusyRef = useRef(false);
  const lastLocationSentAt = useRef(0);
  const missionProgressRef = useRef<MissionProgressState>(
    EMPTY_MISSION_PROGRESS,
  );

  const active =
    manhunt.session !== null &&
    manhunt.gameState?.phase === "active";
  const ownPlayerCaught =
    manhunt.ownPlayerId !== null &&
    manhunt.caughtPlayerIds.includes(manhunt.ownPlayerId);
  const runnerHeadStart =
    manhunt.session !== null &&
    manhunt.gameState?.phase === "countdown" &&
    manhunt.ownTeam === "runner";
  const canSubmitLocation = active || runnerHeadStart;
  const boundary =
    manhuntBoundaryRoomCode === room?.code ? manhuntBoundary : null;

  useEffect(() => {
    if (!canSubmitLocation || !location.location || !room || !manhunt.session) {
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
  }, [canSubmitLocation, location.location, manhunt.session, room]);

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
      useManhuntGameStore.getState().clearFreeze();
      useManhuntGameStore.getState().clearSmokeBombState();
      useManhuntGameStore.getState().clearGhostState();
      useManhuntGameStore.getState().clearFreezeDecoyState();
      useManhuntGameStore.getState().clearFreezeDecoyUsageState();
      useManhuntGameStore.getState().clearLateGameClueState();
      useManhuntGameStore.getState().clearLateGameWarningState();
      setSelectedPlayerId(null);
      setIncomingCatchRequest(null);
    };
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("disconnect", onDisconnect);
      useManhuntGameStore.getState().clearReveal();
      useManhuntGameStore.getState().clearFreezeDecoyState();
      useManhuntGameStore.getState().clearFreezeDecoyUsageState();
      useManhuntGameStore.getState().clearLateGameClueState();
      useManhuntGameStore.getState().clearLateGameWarningState();
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
    return scheduleServerDeadline(
      incomingCatchRequest.expiresAt,
      serverTimeOffsetMs,
      () => {
        setIncomingCatchRequest((current) =>
          current?.requestId === incomingCatchRequest.requestId ? null : current,
        );
      },
    );
  }, [
    incomingCatchRequest?.requestId,
    incomingCatchRequest?.expiresAt,
    serverTimeOffsetMs,
  ]);

  useEffect(() => {
    if (
      !active &&
      !runnerHeadStart &&
      !manhunt.reveal &&
      !manhunt.missionReveal &&
      !manhunt.missionAssignment
    ) {
      return;
    }
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [
    active,
    runnerHeadStart,
    manhunt.reveal?.visibleUntil,
    manhunt.missionReveal?.visibleUntil,
    manhunt.missionAssignment?.deadlineAt,
  ]);

  const revealVisibleUntil = manhunt.reveal
    ? Date.parse(manhunt.reveal.visibleUntil)
    : 0;
  const now = Math.max(clockNow, Date.now());
  const missionAssignment = getVisibleMissionAssignment(
    manhunt.ownTeam,
    playerId,
    manhunt.missionAssignment,
  );
  const missionDeadlinePassed =
    missionAssignment?.status === "active" &&
    !isMissionCircleVisible(missionAssignment, now);
  const missionCircle =
    missionAssignment && isMissionCircleVisible(missionAssignment, now)
      ? {
          center: missionAssignment.center,
          radiusMeters: missionAssignment.radiusMeters,
        }
      : null;
  const serverNow = now + serverTimeOffsetMs;
  const activeFootstepsGuidances = (manhunt.footstepsState?.guidances ?? [])
    .filter((guidance) => Date.parse(guidance.expiresAt) > serverNow);
  const activeFootstepsGuidance = activeFootstepsGuidances.reduce<
    (typeof activeFootstepsGuidances)[number] | null
  >(
    (latest, guidance) =>
      !latest || Date.parse(guidance.startedAt) > Date.parse(latest.startedAt)
        ? guidance
        : latest,
    null,
  );
  const footstepsDeadline = activeFootstepsGuidance
    ? Date.parse(activeFootstepsGuidance.expiresAt)
    : 0;
  const footstepsRemainingSeconds = Math.max(
    0,
    Math.ceil((footstepsDeadline - serverNow) / 1_000),
  );
  const activeSmokeEffects = (manhunt.smokeBombState?.activeEffects ?? [])
    .filter((effect) => Date.parse(effect.expiresAt) > serverNow);
  const activeSmokeEffect = activeSmokeEffects.reduce<
    (typeof activeSmokeEffects)[number] | null
  >(
    (latest, effect) =>
      !latest || Date.parse(effect.startedAt) > Date.parse(latest.startedAt)
        ? effect
        : latest,
    null,
  );
  const smokeBombDeadline = activeSmokeEffect
    ? Date.parse(activeSmokeEffect.expiresAt)
    : 0;
  const smokeBombRemainingSeconds = Math.max(
    0,
    Math.ceil((smokeBombDeadline - serverNow) / 1_000),
  );
  const activeGhostEffects = (manhunt.ghostState?.activeEffects ?? []).filter(
    (effect) => Date.parse(effect.expiresAt) > serverNow,
  );
  const ghostDeadline = activeGhostEffects.reduce(
    (latest, effect) => Math.max(latest, Date.parse(effect.expiresAt)),
    0,
  );
  const ghostRemainingSeconds = Math.max(
    0,
    Math.ceil((ghostDeadline - serverNow) / 1_000),
  );
  const activeFreezeDecoys =
    active && manhunt.ownTeam === "hunter"
      ? getVisibleFreezeDecoys(
          manhunt.freezeDecoyState?.decoys ?? [],
          serverNow,
        )
      : [];
  const activeLateGameClue =
    active && manhunt.ownTeam === "hunter"
      ? getVisibleLateGameClue(manhunt.lateGameClueState, serverNow)
      : null;
  const activeLateGameWarning =
    active && manhunt.ownTeam === "runner"
      ? getVisibleLateGameWarning(manhunt.lateGameWarningState, serverNow)
      : null;
  const lateGameWarningRemainingSeconds = activeLateGameWarning
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(activeLateGameWarning.expiresAt) - serverNow) / 1_000,
        ),
      )
    : 0;
  useEffect(() => {
    const clue = activeLateGameClue;
    if (!clue) {
      return;
    }
    const timer = setTimeout(
      () =>
        useManhuntGameStore
          .getState()
          .clearLateGameClueState(clue.clueId),
      Math.max(
        0,
        Date.parse(clue.expiresAt) - (Date.now() + serverTimeOffsetMs),
      ),
    );
    return () => clearTimeout(timer);
  }, [
    activeLateGameClue?.clueId,
    activeLateGameClue?.expiresAt,
    serverTimeOffsetMs,
  ]);
  useEffect(() => {
    const warning = activeLateGameWarning;
    if (!warning) {
      return;
    }
    const timer = setTimeout(
      () =>
        useManhuntGameStore
          .getState()
          .clearLateGameWarningState(warning.exposureId),
      Math.max(
        0,
        Date.parse(warning.expiresAt) - (Date.now() + serverTimeOffsetMs),
      ),
    );
    return () => clearTimeout(timer);
  }, [
    activeLateGameWarning?.exposureId,
    activeLateGameWarning?.expiresAt,
    serverTimeOffsetMs,
  ]);
  const freezeDecoyNextExpiryMs = activeFreezeDecoys.reduce(
    (earliest, decoy) => Math.min(earliest, Date.parse(decoy.expiresAt)),
    Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (!Number.isFinite(freezeDecoyNextExpiryMs)) {
      return;
    }
    const timer = setTimeout(
      () => setClockNow(Date.now()),
      Math.max(
        0,
        freezeDecoyNextExpiryMs - (Date.now() + serverTimeOffsetMs),
      ),
    );
    return () => clearTimeout(timer);
  }, [freezeDecoyNextExpiryMs, serverTimeOffsetMs]);
  const visibleRevealRemaining = Number.isFinite(revealVisibleUntil)
    ? Math.max(0, Math.ceil((revealVisibleUntil - now) / 1_000))
    : 0;
  const revealActive = revealVisibleUntil > now;
  const missionRevealVisibleUntil = manhunt.missionReveal
    ? Date.parse(manhunt.missionReveal.visibleUntil)
    : 0;
  const missionRevealActive = missionRevealVisibleUntil > now;
  const formattedMissionRevealTime = manhunt.missionReveal
    ? formatMissionCountdown(manhunt.missionReveal.visibleUntil, now)
    : "00:00";
  const missionRevealMessage = getMissionRevealMessage(
    manhunt.ownTeam,
    missionRevealActive ? manhunt.missionReveal : null,
    t,
  );
  const revealLocationsByPlayer = new Map(
    revealActive
      ? (manhunt.reveal?.locations ?? []).map((entry) => [
          entry.playerId,
          entry,
        ])
      : [],
  );
  if (missionRevealActive && missionRevealMessage) {
    for (const entry of manhunt.missionReveal?.locations ?? []) {
      revealLocationsByPlayer.set(entry.playerId, entry);
    }
  }
  const revealLocations = [...revealLocationsByPlayer.values()];
  const missionProgressSeconds = getMissionProgressSeconds(
    missionProgress,
    missionAssignment,
    now,
  );
  const missionProgressPercent = Math.min(
    100,
    (missionProgressSeconds / MANHUNT_MISSION_DWELL_SECONDS) * 100,
  );
  const freezeDeadline =
    manhunt.freezeState?.phase === "warning"
      ? Date.parse(manhunt.freezeState.payload.warningEndsAt)
      : manhunt.freezeState?.phase === "frozen"
        ? Date.parse(manhunt.freezeState.payload.frozenUntil)
        : 0;
  const freezeRemainingSeconds = Math.max(
    0,
    Math.ceil((freezeDeadline - serverNow) / 1_000),
  );

  useEffect(() => {
    if (!active || manhunt.ownTeam !== "hunter" || !footstepsDeadline) {
      return;
    }
    const timer = setTimeout(
      () => setClockNow(Date.now()),
      Math.max(0, footstepsDeadline - (Date.now() + serverTimeOffsetMs)),
    );
    return () => clearTimeout(timer);
  }, [active, footstepsDeadline, manhunt.ownTeam, serverTimeOffsetMs]);

  useEffect(() => {
    if (!active || manhunt.ownTeam !== "runner" || !smokeBombDeadline) {
      return;
    }
    const timer = setTimeout(
      () => setClockNow(Date.now()),
      Math.max(0, smokeBombDeadline - (Date.now() + serverTimeOffsetMs)),
    );
    return () => clearTimeout(timer);
  }, [active, manhunt.ownTeam, serverTimeOffsetMs, smokeBombDeadline]);

  useEffect(() => {
    if (!active || manhunt.ownTeam !== "runner" || !ghostDeadline) {
      return;
    }
    const timer = setTimeout(
      () => setClockNow(Date.now()),
      Math.max(0, ghostDeadline - (Date.now() + serverTimeOffsetMs)),
    );
    return () => clearTimeout(timer);
  }, [active, ghostDeadline, manhunt.ownTeam, serverTimeOffsetMs]);

  useEffect(() => {
    missionProgressRef.current = EMPTY_MISSION_PROGRESS;
    setMissionProgress(EMPTY_MISSION_PROGRESS);
  }, [
    missionAssignment?.sessionId,
    missionAssignment?.playerId,
    missionAssignment?.revealedAt,
    missionAssignment?.status,
  ]);

  useEffect(() => {
    const updated = updateMissionProgress(
      missionProgressRef.current,
      missionAssignment,
      location.location,
      Date.now(),
    );
    if (updated !== missionProgressRef.current) {
      missionProgressRef.current = updated;
      setMissionProgress(updated);
    }
  }, [location.location, missionAssignment]);
  const formattedRevealTime = `00:${String(visibleRevealRemaining).padStart(2, "0")}`;
  const gameEndsAt = manhunt.gameState?.gameEndsAt
    ? Date.parse(manhunt.gameState.gameEndsAt)
    : Number.NaN;
  const gameRemainingSeconds = Number.isFinite(gameEndsAt)
    ? Math.max(0, Math.ceil((gameEndsAt - serverNow) / 1_000))
    : null;
  const formattedGameTime = gameRemainingSeconds === null
    ? "--:--"
    : `${String(Math.floor(gameRemainingSeconds / 60)).padStart(2, "0")}:${String(gameRemainingSeconds % 60).padStart(2, "0")}`;
  const shrinkWarningEndsAt = manhunt.gameState?.shrinkWarningEndsAt
    ? Date.parse(manhunt.gameState.shrinkWarningEndsAt)
    : Number.NaN;
  const shrinkCountdownRemaining = Number.isFinite(shrinkWarningEndsAt) &&
    shrinkWarningEndsAt > serverNow
    ? Math.max(0, Math.ceil((shrinkWarningEndsAt - serverNow) / 1_000))
    : 0;
  const runnerHeadStartEndsAt = manhunt.gameState?.runnerHeadStartEndsAt
    ? Date.parse(manhunt.gameState.runnerHeadStartEndsAt)
    : Number.NaN;
  const runnerHeadStartRemaining = runnerHeadStart && Number.isFinite(runnerHeadStartEndsAt)
    ? Math.max(0, Math.ceil((runnerHeadStartEndsAt - serverNow) / 1_000))
    : null;
  const hunterReleaseAt = manhunt.gameState?.countdownEndsAt
    ? Date.parse(manhunt.gameState.countdownEndsAt)
    : Number.NaN;
  const hunterReleaseRemaining = runnerHeadStart && Number.isFinite(hunterReleaseAt)
    ? Math.max(0, Math.ceil((hunterReleaseAt - serverNow) / 1_000))
    : null;

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
    if (!target || target.status === "caught" ||
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
          : t("manhunt.error.catchSubmit"),
      );
    }
  };

  const activateFootsteps = async () => {
    if (
      !active ||
      manhunt.ownTeam !== "hunter" ||
      !room ||
      !manhunt.session ||
      !manhunt.footstepsState ||
      manhunt.footstepsState.remainingUses <= 0 ||
      footstepsPending
    ) {
      return;
    }
    setFootstepsPending(true);
    try {
      const response = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.FOOTSTEPS,
        payload: {
          roomCode: room.code,
          sessionId: manhunt.session.id,
          requestId: Crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      manhunt.setError(null);
    } catch (error) {
      manhunt.setError(
        error instanceof Error
        ? error.message
        : "Could not activate Footsteps.",
      );
    } finally {
      setFootstepsPending(false);
    }
  };

  const activateSmokeBomb = async () => {
    if (
      !active ||
      manhunt.ownTeam !== "runner" ||
      !room ||
      !manhunt.session ||
      !manhunt.smokeBombState ||
      manhunt.smokeBombState.remainingUses <= 0 ||
      smokeBombPending
    ) {
      return;
    }
    setSmokeBombPending(true);
    try {
      const response = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.SMOKE_BOMB,
        payload: {
          roomCode: room.code,
          sessionId: manhunt.session.id,
          requestId: Crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      manhunt.setError(null);
    } catch (error) {
      manhunt.setError(
        error instanceof Error
        ? error.message
        : "Could not activate Smoke Bomb.",
      );
    } finally {
      setSmokeBombPending(false);
    }
  };

  const activateGhost = async () => {
    if (
      !active ||
      manhunt.ownTeam !== "runner" ||
      !room ||
      !manhunt.session ||
      !manhunt.ghostState ||
      manhunt.ghostState.usageLimit === null ||
      manhunt.ghostState.remainingUses === null ||
      manhunt.ghostState.remainingUses <= 0 ||
      ghostPending
    ) {
      return;
    }
    setGhostPending(true);
    try {
      const response = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.GHOST,
        payload: {
          roomCode: room.code,
          sessionId: manhunt.session.id,
          requestId: Crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      manhunt.setError(null);
    } catch (error) {
      manhunt.setError(
        error instanceof Error
          ? error.message
          : "Could not activate Ghost.",
      );
    } finally {
      setGhostPending(false);
    }
  };

  const activateFreezeDecoy = async () => {
    if (
      !active ||
      manhunt.ownTeam !== "runner" ||
      !room ||
      !manhunt.session ||
      !manhunt.freezeDecoyUsageState ||
      manhunt.freezeDecoyUsageState.remainingUses <= 0 ||
      freezeDecoyPending
    ) {
      return;
    }
    setFreezeDecoyPending(true);
    try {
      const response = await emitWithAcknowledgement({
        event: MANHUNT_EVENTS.FREEZE_DECOY,
        payload: {
          roomCode: room.code,
          sessionId: manhunt.session.id,
          requestId: Crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      manhunt.setError(null);
    } catch (error) {
      manhunt.setError(
        error instanceof Error
          ? error.message
          : "Could not activate Freeze Decoy.",
      );
    } finally {
      setFreezeDecoyPending(false);
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
        missionCircle={missionCircle}
        revealedLocations={revealLocations}
        decoyLocations={activeFreezeDecoys}
        lateGameClue={activeLateGameClue}
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
            leftLabel={t("manhunt.mode.title")}
            leftValue={
              manhunt.ownTeam
                ? t(
                    manhunt.ownTeam === "hunter"
                      ? "manhunt.team.hunter"
                      : "manhunt.team.runner",
                  ).toUpperCase()
                : t("manhunt.map.team").toUpperCase()
            }
            rightLabel={t("manhunt.map.game")}
            rightValue={formattedGameTime}
          />
          {shrinkCountdownRemaining > 0 ? (
            <MapBanner
              message={t("manhunt.map.safeZoneShrinking")}
              timer={`${shrinkCountdownRemaining}s`}
              style={styles.revealBanner}
            />
          ) : null}
          {runnerHeadStart ? (
            <HudPanel style={styles.headStartPanel}>
              <Text style={styles.headStartTitle}>
                {runnerHeadStartRemaining === null
                  ? t("manhunt.map.syncingRunnerCountdown")
                  : runnerHeadStartRemaining > 0
                    ? t("manhunt.map.run")
                    : t("manhunt.map.headStartComplete")}
              </Text>
              {runnerHeadStartRemaining !== null &&
              runnerHeadStartRemaining > 0 ? (
                <Text style={styles.headStartCountdown}>
                  {runnerHeadStartRemaining}
                </Text>
              ) : null}
              {runnerHeadStartRemaining === 0 &&
              hunterReleaseRemaining !== null ? (
                <Text style={styles.statusMessage}>
                  {t("manhunt.map.hunterRelease", {
                    seconds: hunterReleaseRemaining,
                  })}
                </Text>
              ) : null}
            </HudPanel>
          ) : null}
          {manhunt.huntStartedAnnouncement ? (
            <HudPanel style={styles.huntStartedPanel}>
              <Text style={styles.huntStartedText}>
                {t("manhunt.map.huntStarted")}
              </Text>
            </HudPanel>
          ) : null}
          {revealActive ? (
            <MapBanner
              message={t("manhunt.map.locationReveal")}
              timer={formattedRevealTime}
              style={styles.revealBanner}
            />
          ) : null}
          {missionRevealActive ? (
            <MapBanner
              message={missionRevealMessage ?? t("manhunt.map.missionReveal")}
              timer={formattedMissionRevealTime}
              style={styles.revealBanner}
            />
          ) : null}
          {activeLateGameWarning ? (
            <MapBanner
              message={t("manhunt.map.lastKnownExposed")}
              timer={`${lateGameWarningRemainingSeconds}s`}
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
            <Text style={styles.mapLoadingText}>
              {t("manhunt.map.loading")}
            </Text>
          </View>
        ) : null}

        <View style={styles.bottomContent}>
          {mapStatus === "error" ? (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusTitle}>
                {t("manhunt.map.unavailable")}
              </Text>
              <Text style={styles.statusMessage}>
                {localizeManhuntError(mapError, t) ?? mapError}
              </Text>
              <PrimaryButton
                title={t("manhunt.map.retry")}
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
              <Text style={styles.statusMessage}>
                {localizeManhuntError(manhunt.error, t) ?? manhunt.error}
              </Text>
            </HudPanel>
          ) : null}

          {manhunt.ownTeam === "hunter" &&
          manhunt.catchRequestStatus?.status ? (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusMessage}>
                {catchRequestStatusMessage(manhunt.catchRequestStatus.status, t)}
              </Text>
            </HudPanel>
          ) : null}

          {manhunt.ownTeam === "hunter" ? (
            <View style={styles.catchAction}>
              <PrimaryButton
                title={
                  manhunt.catchPending
                    ? t("manhunt.map.catchWaiting")
                    : selectedPlayerId
                      ? t("manhunt.map.catchRequest")
                      : t("manhunt.map.catchSelect")
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
                {t("manhunt.map.catchHint")}
              </Text>
            </View>
          ) : missionAssignment ? (
            <HudPanel
              highlightColor={colors.gold}
              style={styles.missionPanel}
            >
              <View style={styles.missionHeader}>
                <Target color={colors.gold} size={20} />
                <Text style={styles.missionTitle}>
                  {t("manhunt.map.missionTitle")}
                </Text>
                {missionAssignment.status === "active" &&
                !missionDeadlinePassed ? (
                  <Text style={styles.missionDeadline}>
                    {formatMissionCountdown(missionAssignment.deadlineAt, now)}
                  </Text>
                ) : null}
              </View>
              {missionAssignment.status === "active" ? (
                missionDeadlinePassed ? (
                  <Text style={styles.statusMessage}>
                    {t("manhunt.map.missionDeadlinePassed")}
                  </Text>
                ) : (
                  <>
                    <Text style={styles.statusMessage}>
                      {t("manhunt.map.missionInstructions", {
                        seconds: MANHUNT_MISSION_DWELL_SECONDS,
                      })}
                    </Text>
                    <View style={styles.missionProgressRow}>
                      <Text style={styles.missionProgressLabel}>
                        {t("manhunt.map.missionTimeInside")}
                      </Text>
                      <Text style={styles.missionProgressValue}>
                        {missionProgressSeconds.toFixed(1)} /{" "}
                        {MANHUNT_MISSION_DWELL_SECONDS}s
                      </Text>
                    </View>
                    <View
                      accessibilityRole="progressbar"
                      accessibilityLabel={t(
                        "manhunt.map.missionTimeAccessibility",
                      )}
                      accessibilityValue={{
                        min: 0,
                        max: MANHUNT_MISSION_DWELL_SECONDS,
                        now: missionProgressSeconds,
                      }}
                      style={styles.missionProgressTrack}
                    >
                      <View
                        style={[
                          styles.missionProgressFill,
                          { width: `${missionProgressPercent}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.missionDeadlineHint}>
                      {t("manhunt.map.missionDeadlineIn")}{" "}
                      {formatMissionCountdown(
                        missionAssignment.deadlineAt,
                        now,
                      )}
                    </Text>
                  </>
                )
              ) : (
                <Text style={styles.statusMessage}>
                  {missionAssignment.status === "completed"
                    ? t("manhunt.map.missionCompleteWaiting")
                    : missionAssignment.status === "failed"
                      ? t("manhunt.map.missionDeadlineExpired")
                      : t("manhunt.map.missionEnded")}
                </Text>
              )}
            </HudPanel>
          ) : (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusTitle}>
                {t("manhunt.map.runnerTitle")}
              </Text>
              <Text style={styles.statusMessage}>
                {t("manhunt.map.runnerPrivacy")}
              </Text>
            </HudPanel>
          )}

          {manhunt.ownTeam === "runner" && manhunt.freezeState && (
            <HudPanel style={styles.statusPanel}>
              <Text style={styles.statusTitle}>
                {manhunt.freezeState.phase === "warning"
                  ? t("manhunt.map.freezeWarning")
                  : t("manhunt.map.frozen")}
              </Text>
              <Text style={styles.statusMessage}>
                {manhunt.freezeState.phase === "warning"
                  ? t("manhunt.map.freezeTakesEffect", {
                      seconds: freezeRemainingSeconds,
                    })
                  : t("manhunt.map.movementPaused", {
                      seconds: freezeRemainingSeconds,
                    })}
              </Text>
            </HudPanel>
          )}

          {active &&
            manhunt.ownTeam === "runner" &&
            !ownPlayerCaught && (
            <>
              <HudPanel style={styles.statusPanel}>
                <Text style={styles.statusTitle}>
                  {t("manhunt.map.ability.freezeDecoy")}
                </Text>
                <Text style={styles.statusMessage}>
                  {manhunt.freezeDecoyUsageState
                    ? t("manhunt.map.ability.usesRemaining", {
                        count: manhunt.freezeDecoyUsageState.remainingUses,
                      })
                    : t("manhunt.map.ability.syncUses")}
                </Text>
                <Text style={styles.statusMessage}>
                  {t("manhunt.map.ability.freezeDecoyDescription", {
                    seconds: MANHUNT_FREEZE_DECOY_DURATION_SECONDS,
                  })}
                </Text>
              </HudPanel>
              <PrimaryButton
                title={
                  freezeDecoyPending
                    ? t("manhunt.map.ability.activateFreezeDecoy")
                    : manhunt.freezeDecoyUsageState?.remainingUses === 0
                      ? t("manhunt.map.ability.noFreezeDecoyUses")
                      : t("manhunt.map.ability.useFreezeDecoy")
                }
                variant="secondary"
                disabled={
                  freezeDecoyPending ||
                  !manhunt.freezeDecoyUsageState ||
                  manhunt.freezeDecoyUsageState.remainingUses === 0
                }
                onPress={() => void activateFreezeDecoy()}
              />
              <HudPanel style={styles.statusPanel}>
                <Text style={styles.statusTitle}>
                  {t("manhunt.map.ability.smokeBomb")}
                </Text>
                <Text style={styles.statusMessage}>
                  {manhunt.smokeBombState
                    ? t("manhunt.map.ability.usesRemaining", {
                        count: manhunt.smokeBombState.remainingUses,
                      })
                    : t("manhunt.map.ability.syncUses")}
                </Text>
                {activeSmokeEffect && (
                  <Text style={styles.statusMessage}>
                    {t("manhunt.map.ability.smokeBombActive", {
                      seconds: smokeBombRemainingSeconds,
                    })}
                  </Text>
                )}
              </HudPanel>
              <PrimaryButton
                title={
                  smokeBombPending
                    ? t("manhunt.map.ability.activateSmokeBomb")
                    : manhunt.smokeBombState?.remainingUses === 0
                      ? t("manhunt.map.ability.noSmokeBombUses")
                      : t("manhunt.map.ability.useSmokeBomb")
                }
                variant="secondary"
                disabled={
                  smokeBombPending ||
                  !manhunt.smokeBombState ||
                  manhunt.smokeBombState.remainingUses === 0
                }
                onPress={() => void activateSmokeBomb()}
              />
              <HudPanel style={styles.statusPanel}>
                <Text style={styles.statusTitle}>
                  {t("manhunt.map.ability.ghost")}
                </Text>
                <Text style={styles.statusMessage}>
                  {!manhunt.ghostState
                    ? t("manhunt.map.ability.syncStatus")
                    : manhunt.ghostState.usageLimit === null
                      ? t("manhunt.map.ability.ghostUnavailableDescription")
                      : t("manhunt.map.ability.ghostAvailableDescription", {
                          seconds: MANHUNT_GHOST_DURATION_SECONDS,
                          count: manhunt.ghostState.remainingUses ?? 0,
                        })}
                </Text>
                {ghostDeadline > serverNow && (
                  <Text style={styles.statusMessage}>
                    {t("manhunt.map.ability.smokeBombActive", {
                      seconds: ghostRemainingSeconds,
                    })}
                  </Text>
                )}
              </HudPanel>
              <PrimaryButton
                title={
                  ghostPending
                    ? t("manhunt.map.ability.activateGhost")
                    : !manhunt.ghostState
                      ? t("manhunt.map.ability.syncGhost")
                      : manhunt.ghostState.usageLimit === null
                        ? t("manhunt.map.ability.ghostUnavailable")
                        : manhunt.ghostState.remainingUses === 0
                          ? t("manhunt.map.ability.noGhostUses")
                          : t("manhunt.map.ability.useGhost")
                }
                variant="secondary"
                disabled={
                  ghostPending ||
                  !manhunt.ghostState ||
                  manhunt.ghostState.usageLimit === null ||
                  manhunt.ghostState.remainingUses === null ||
                  manhunt.ghostState.remainingUses === 0
                }
                onPress={() => void activateGhost()}
              />
            </>
          )}

          {active && manhunt.ownTeam === "hunter" && (
            <>
              <HudPanel style={styles.statusPanel}>
                <Text style={styles.statusTitle}>
                  {t("manhunt.map.ability.footsteps")}
                </Text>
                <Text style={styles.statusMessage}>
                  {manhunt.footstepsState
                    ? t("manhunt.map.ability.usesRemaining", {
                        count: manhunt.footstepsState.remainingUses,
                      })
                    : t("manhunt.map.ability.syncUses")}
                </Text>
                {activeFootstepsGuidance && (
                  <View style={styles.directionRow}>
                    <Navigation
                      size={24}
                      color={colors.teal}
                      style={{
                        transform: [
                          { rotate: `${activeFootstepsGuidance.bearingDegrees}deg` },
                        ],
                      }}
                    />
                    <View>
                      <Text style={styles.statusTitle}>
                        {formatCompassDirection(
                          activeFootstepsGuidance.bearingDegrees,
                          t,
                        )}
                      </Text>
                      <Text style={styles.statusMessage}>
                        {t("manhunt.map.ability.guidanceEnds", {
                          seconds: footstepsRemainingSeconds,
                        })}
                      </Text>
                    </View>
                  </View>
                )}
              </HudPanel>
              <PrimaryButton
                title={
                  footstepsPending
                    ? t("manhunt.map.ability.activateFootsteps")
                    : manhunt.footstepsState?.remainingUses === 0
                      ? t("manhunt.map.ability.noFootstepsUses")
                      : t("manhunt.map.ability.useFootsteps")
                }
                variant="secondary"
                disabled={
                  footstepsPending ||
                  !manhunt.footstepsState ||
                  manhunt.footstepsState.remainingUses === 0
                }
                onPress={() => void activateFootsteps()}
              />
            </>
          )}

          <PrimaryButton
            title={t("manhunt.map.ability.freezeUnavailable")}
            variant="secondary"
            disabled
            onPress={() => undefined}
          />

          <View style={styles.mapControls}>
            <IconButton
              icon={ArrowLeft}
              accessibilityLabel={t("manhunt.common.back")}
              onPress={() => router.back()}
            />
            <IconButton
              icon={LocateFixed}
              accessibilityLabel={t("manhunt.map.recenter")}
              disabled={!location.location || mapStatus !== "ready"}
              iconColor={colors.teal}
              onPress={() => setRecenterVersion((value) => value + 1)}
            />
            <IconButton
              icon={Settings}
              accessibilityLabel={t("manhunt.map.locationSettings")}
              onPress={() => void location.openAppSettings()}
            />
          </View>
        </View>
      </SafeAreaView>
      <ManhuntCatchConfirmationModal
        request={incomingCatchRequest}
        busy={catchResponseBusy}
        error={localizeManhuntError(catchResponseError, t)}
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
  t: ReturnType<typeof useTranslation>,
): string {
  switch (status) {
    case "pending":
      return t("manhunt.map.catchStatus.pending");
    case "rejected":
      return t("manhunt.map.catchStatus.rejected");
    case "expired":
      return t("manhunt.map.catchStatus.expired");
    case "cancelled":
      return t("manhunt.map.catchStatus.cancelled");
    case "accepted":
      return t("manhunt.map.catchStatus.accepted");
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
  headStartPanel: {
    alignItems: "center",
    gap: spacing.xs,
    marginHorizontal: spacing.md,
    borderColor: colors.green,
    borderWidth: 2,
  },
  headStartTitle: {
    ...typography.headline,
    color: colors.green,
    textAlign: "center",
  },
  headStartCountdown: {
    ...typography.title,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  huntStartedPanel: {
    alignItems: "center",
    marginHorizontal: spacing.md,
    backgroundColor: colors.pink,
  },
  huntStartedText: {
    ...typography.headline,
    color: colors.textOnAccent,
    textAlign: "center",
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
  directionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  catchAction: {
    gap: spacing.xs,
  },
  missionPanel: {
    gap: spacing.sm,
    borderColor: colors.gold,
    borderWidth: 2,
  },
  missionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  missionTitle: {
    ...typography.body,
    color: colors.gold,
    flex: 1,
  },
  missionDeadline: {
    ...typography.small,
    color: colors.gold,
    fontVariant: ["tabular-nums"],
  },
  missionProgressRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  missionProgressLabel: {
    ...typography.small,
    color: colors.textMuted,
  },
  missionProgressValue: {
    ...typography.small,
    color: colors.gold,
    fontVariant: ["tabular-nums"],
  },
  missionProgressTrack: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.panelRaised,
  },
  missionProgressFill: {
    height: "100%",
    backgroundColor: colors.gold,
  },
  missionDeadlineHint: {
    ...typography.small,
    color: colors.textMuted,
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

function formatCompassDirection(
  bearingDegrees: number,
  t: ReturnType<typeof useTranslation>,
): string {
  const directions = [
    "manhunt.map.compass.north",
    "manhunt.map.compass.northeast",
    "manhunt.map.compass.east",
    "manhunt.map.compass.southeast",
    "manhunt.map.compass.south",
    "manhunt.map.compass.southwest",
    "manhunt.map.compass.west",
    "manhunt.map.compass.northwest",
  ] as const;
  return t(directions[Math.round(bearingDegrees / 45) % directions.length]!);
}
