import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createLanguageStore,
  LANGUAGE_PREFERENCE_KEY,
} from "../src/i18n/language-store.ts";
import { languageOptions, translations } from "../src/i18n/locales.ts";
import { tutorialPages } from "../src/i18n/tutorial-content.ts";
import { translate } from "../src/i18n/translate.ts";
import { localizeImpostorError } from "../src/i18n/impostor-errors.ts";
import { localizeManhuntError } from "../src/i18n/manhunt-errors.ts";
import { localizeSharedError } from "../src/i18n/shared-errors.ts";
import { useClassicGameStore } from "../src/store/classic-game-store.ts";
import { useManhuntGameStore } from "../src/store/manhunt-game-store.ts";
import { useRoomStore } from "../src/store/room-store.ts";
import { useWordGameStore } from "../src/store/word-game-store.ts";

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getItemAsync(key) {
      return values.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      values.set(key, value);
    },
  };
}

test("English is the default when no language preference exists", async () => {
  const store = createLanguageStore(createMemoryStorage());
  assert.equal(store.getState().language, "en");
  await store.getState().hydrate();
  assert.equal(store.getState().language, "en");
});

test("Spanish, French, and Italian preferences survive store recreation", async () => {
  for (const language of ["es", "fr", "it"]) {
    const storage = createMemoryStorage();
    const firstLaunchStore = createLanguageStore(storage);
    await firstLaunchStore.getState().setLanguage(language);
    assert.equal(storage.values.get(LANGUAGE_PREFERENCE_KEY), language);

    const restartedStore = createLanguageStore(storage);
    await restartedStore.getState().hydrate();
    assert.equal(restartedStore.getState().language, language);
  }
});

test("invalid saved language values fall back to English", async () => {
  const store = createLanguageStore(
    createMemoryStorage({ [LANGUAGE_PREFERENCE_KEY]: "pt" }),
  );
  await store.getState().hydrate();
  assert.equal(store.getState().language, "en");
});

test("changing language updates translated text immediately", async () => {
  let finishWrite;
  const storage = {
    async getItemAsync() {
      return null;
    },
    setItemAsync() {
      return new Promise((resolve) => {
        finishWrite = resolve;
      });
    },
  };
  const store = createLanguageStore(storage);
  const before = translate(store.getState().language, "home.createRoom");
  const saving = store.getState().setLanguage("es");
  const after = translate(store.getState().language, "home.createRoom");
  assert.equal(before, "Create a room");
  assert.equal(after, "Crear una sala");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof finishWrite, "function");
  finishWrite();
  await saving;
});

test("missing localized keys fall back to English and interpolate values", () => {
  assert.equal(
    translate("fr", "lobby.playerCount", { players: 2, maximum: 8 }, {
      fr: {},
    }),
    "2 / 8 players",
  );
  assert.equal(
    translate("it", "tutorial.pageCount", { current: 1, total: 4 }),
    "1 di 4",
  );
});

test("shared UI translations exist in all four languages with matching placeholders", () => {
  const sharedKeys = [
    "common.roomCodeCharacter",
    "shared.font.loadFailureTitle",
    "shared.font.loadFailureMessage",
    "shared.font.timeoutTitle",
    "shared.font.timeoutMessage",
    "shared.font.loading",
    "shared.error.serverDisconnected",
    "shared.error.connectionConfiguration",
    "shared.error.apiUrlMissing",
    "shared.error.apiUrlInvalid",
    "shared.error.apiUrlProtocol",
    "shared.error.apiUrlHttps",
    "shared.error.roomLookupStatus",
    "shared.error.invalidRoomResponse",
    "shared.error.invalidJson",
    "shared.error.reconnectToken",
    "shared.error.reconnectJson",
    "shared.error.reconnectShape",
    "shared.error.roomCreationInvalid",
    "shared.error.roomSettingsInvalid",
    "shared.error.roomJoinInvalid",
    "shared.error.roomSettingsPayloadInvalid",
    "shared.error.roomNoLongerAccepting",
    "shared.error.roomLimitReached",
    "shared.error.roomSettingsLocked",
    "shared.error.playerLimitBelowCurrent",
    "shared.error.differentGameMode",
    "shared.error.returnFinishedGameFirst",
    "shared.error.gameCanNoLongerStart",
    "shared.error.reconnectCredentialsInvalid",
    "shared.error.connectionAlreadyMember",
    "shared.error.connectionAlreadyJoined",
    "shared.error.connectionNotMember",
    "shared.error.hostOnly",
    "shared.error.playerNotInRoom",
    "shared.error.roomCodeUnavailable",
  ];
  const placeholders = (message) =>
    [...message.matchAll(/\{([^}]+)\}/g)]
      .map((match) => match[1])
      .sort();

  for (const language of ["en", "es", "fr", "it"]) {
    for (const key of sharedKeys) {
      assert.ok(translations[language][key], `${language} is missing ${key}`);
    }
  }
  for (const language of ["es", "fr", "it"]) {
    for (const key of sharedKeys) {
      assert.deepEqual(
        placeholders(translations[language][key]),
        placeholders(translations.en[key]),
        `${language} changed interpolation variables for ${key}`,
      );
    }
  }
});

test("shared errors localize recognized messages and preserve unknown details", () => {
  const unknown = "Socket.IO: connection failed with native detail";
  const recognizedErrors = [
    ["Room creation payload is invalid.", "shared.error.roomCreationInvalid"],
    ["Room settings are invalid.", "shared.error.roomSettingsInvalid"],
    ["Room joining payload is invalid.", "shared.error.roomJoinInvalid"],
    ["Room settings payload is invalid.", "shared.error.roomSettingsPayloadInvalid"],
    ["This room is no longer accepting players.", "shared.error.roomNoLongerAccepting"],
    ["Room has reached its player limit.", "shared.error.roomLimitReached"],
    ["Room settings cannot be changed after a game has started.", "shared.error.roomSettingsLocked"],
    ["The player limit cannot be lower than the current room size.", "shared.error.playerLimitBelowCurrent"],
    ["The room is configured for a different game mode.", "shared.error.differentGameMode"],
    ["Return the finished game to the lobby before starting another.", "shared.error.returnFinishedGameFirst"],
    ["The game can no longer start.", "shared.error.gameCanNoLongerStart"],
    ["Reconnect credentials are invalid or expired.", "shared.error.reconnectCredentialsInvalid"],
    ["This connection is already a member of another room.", "shared.error.connectionAlreadyMember"],
    ["This connection has already joined a room.", "shared.error.connectionAlreadyJoined"],
    ["This connection is not a member of the requested room.", "shared.error.connectionNotMember"],
    ["Only the room host can perform this action.", "shared.error.hostOnly"],
    ["Player is not in this room.", "shared.error.playerNotInRoom"],
    ["Unable to allocate a unique room code. Please try again.", "shared.error.roomCodeUnavailable"],
  ];

  for (const language of ["en", "es", "fr", "it"]) {
    const t = (key, values) => translate(language, key, values);
    assert.equal(
      localizeSharedError("The server disconnected this client.", t),
      t("shared.error.serverDisconnected"),
    );
    assert.equal(
      localizeSharedError("Room lookup failed (503).", t),
      t("shared.error.roomLookupStatus", { status: 503 }),
    );
    assert.equal(
      localizeSharedError("Could not synchronize the server clock. Countdown timing is unavailable.", t),
      t("impostor.error.clockSync"),
    );
    for (const [message, key] of recognizedErrors) {
      assert.equal(localizeSharedError(message, t), t(key), `${language}: ${message}`);
    }
    assert.equal(localizeSharedError(unknown, t), unknown);
  }

  assert.equal(
    translate("fr", "shared.error.roomLookupStatus", { status: 503 }, {
      fr: {},
    }),
    "Room lookup failed (503).",
  );
  assert.equal(
    translate("it", "common.roomCodeCharacter", { current: 2, total: 4 }),
    "Carattere 2 di 4 del codice stanza",
  );
});

test("language preference writes leave guest nickname and reconnect data intact", async () => {
  const nickname = "Hidden Fox";
  const reconnect = JSON.stringify({
    roomCode: "ABCD",
    playerId: "player-id",
    reconnectToken: "secret-token",
  });
  const storage = createMemoryStorage({
    "impostor.playerNickname": nickname,
    "impostor.reconnectSession": reconnect,
  });
  const store = createLanguageStore(storage);
  await store.getState().setLanguage("fr");

  assert.equal(storage.values.get("impostor.playerNickname"), nickname);
  assert.equal(storage.values.get("impostor.reconnectSession"), reconnect);
  assert.equal(storage.values.get(LANGUAGE_PREFERENCE_KEY), "fr");
});

test("changing language does not reset an active Manhunt session", async () => {
  const session = {
    id: "local-session",
    roomCode: "ABCD",
    status: "in_progress",
    gameMode: "manhunt",
    startedAt: "2026-01-01T00:00:00.000Z",
    state: {
      phase: "active",
      activeSince: "2026-01-01T00:00:00.000Z",
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
      readyPlayerIds: [],
    },
  };
  const gameStore = useManhuntGameStore.getState();
  gameStore.reset();
  gameStore.setSession(session, []);
  gameStore.setOwnTeam("local-session", "runner-id", "runner");
  const before = useManhuntGameStore.getState();

  const languageStore = createLanguageStore(createMemoryStorage());
  await languageStore.getState().setLanguage("it");
  const after = useManhuntGameStore.getState();

  assert.strictEqual(after.session, before.session);
  assert.strictEqual(after.gameState, before.gameState);
  assert.equal(after.ownTeam, "runner");
  after.reset();
});

test("only the four native-named languages are offered", () => {
  assert.deepEqual(languageOptions, [
    { code: "en", nativeName: "English" },
    { code: "es", nativeName: "Español" },
    { code: "fr", nativeName: "Français" },
    { code: "it", nativeName: "Italiano" },
  ]);
});

test("all four tutorial catalogs contain every required tutorial section", () => {
  const requiredKeys = [
    "tutorial.welcome.title",
    "tutorial.welcome.tagline",
    "tutorial.impostor.roles.title",
    "tutorial.impostor.discuss.title",
    "tutorial.impostor.vote.title",
    "tutorial.impostor.win.title",
    "tutorial.manhunt.teams.title",
    "tutorial.manhunt.boundary.title",
    "tutorial.manhunt.missions.title",
    "tutorial.manhunt.outcomes.title",
    "tutorial.abilities.runner.title",
    "tutorial.abilities.hunter.title",
    "tutorial.abilities.inventory.title",
  ];
  const translatedSentenceKeys = [
    "tutorial.welcome.description",
    "tutorial.impostor.roles.description",
    "tutorial.manhunt.missions.description",
    "tutorial.abilities.inventory.description",
  ];

  for (const language of ["en", "es", "fr", "it"]) {
    assert.deepEqual(
      Object.keys(translations[language]).sort(),
      Object.keys(translations.en).sort(),
    );
    for (const key of requiredKeys) {
      assert.ok(translations[language][key], `${language} is missing ${key}`);
    }
    if (language !== "en") {
      for (const key of translatedSentenceKeys) {
        assert.notEqual(
          translations[language][key],
          translations.en[key],
          `${language} has untranslated ${key}`,
        );
      }
    }
    assert.equal(tutorialPages.length, 3);
    assert.ok(tutorialPages.every((page) => page.points.length === 4));
  }
});

test("all four catalogs contain the required Impostor gameplay keys", () => {
  const requiredKeys = [
    "common.round",
    "impostor.setup.classicTitle",
    "impostor.setup.wordTitle",
    "impostor.setup.category.animals",
    "impostor.role.wordPrivacy",
    "impostor.role.revealAccessibility",
    "impostor.discussion.wordDescription",
    "impostor.discussion.tieRevote",
    "impostor.vote.privateInstructions",
    "impostor.vote.revoteRequested",
    "impostor.vote.sentWaiting",
    "impostor.reveal.gameWinner",
    "impostor.reveal.wordAndRoles",
    "impostor.reveal.returnToLobby",
  ];

  for (const language of ["en", "es", "fr", "it"]) {
    for (const key of requiredKeys) {
      assert.ok(translations[language][key], `${language} is missing ${key}`);
    }
  }
});

test("Impostor translations preserve every interpolation variable", () => {
  const keys = Object.keys(translations.en).filter((key) =>
    key.startsWith("impostor."),
  );
  const placeholders = (message) =>
    [...message.matchAll(/\{([^}]+)\}/g)]
      .map((match) => match[1])
      .sort();

  for (const language of ["es", "fr", "it"]) {
    for (const key of keys) {
      assert.deepEqual(
        placeholders(translations[language][key]),
        placeholders(translations.en[key]),
        `${language} changed interpolation variables for ${key}`,
      );
    }
  }
});

test("Impostor gameplay copy falls back to English and interpolates in every language", () => {
  assert.equal(
    translate("fr", "impostor.role.wordPrivacy", undefined, { fr: {} }),
    translations.en["impostor.role.wordPrivacy"],
  );

  for (const language of ["en", "es", "fr", "it"]) {
    const text = translate(language, "impostor.vote.countSummary", {
      submitted: 3,
      eligible: 5,
    });
    assert.match(text, /3/);
    assert.match(text, /5/);
    assert.doesNotMatch(text, /\{(?:submitted|eligible)\}/);

    const error = localizeImpostorError(
      "Reconnect before submitting your vote.",
      (key, values) => translate(language, key, values),
    );
    assert.equal(error, translations[language]["impostor.vote.reconnectBeforeSubmit"]);

    const serverError = localizeImpostorError(
      "Word Impostor requires at least 3 players.",
      (key, values) => translate(language, key, values),
    );
    assert.equal(
      serverError,
      translate(language, "impostor.error.minimumPlayers", {
        mode: translations[language]["impostor.mode.word"],
        count: 3,
      }),
    );
  }
});

test("role, discussion, vote, and reveal screens render catalog-backed copy", async () => {
  const screens = {
    role: {
      path: "../app/imposter/role.tsx",
      keys: ["impostor.role.privateChip", "impostor.role.wordPrivacy"],
    },
    discussion: {
      path: "../app/imposter/discussion.tsx",
      keys: [
        "impostor.discussion.wordTitle",
        "impostor.discussion.tieRevote",
      ],
    },
    vote: {
      path: "../app/imposter/vote.tsx",
      keys: ["impostor.vote.privateInstructions", "impostor.vote.submit"],
    },
    reveal: {
      path: "../app/imposter/reveal.tsx",
      keys: ["impostor.reveal.gameWinner", "impostor.reveal.wordAndRoles"],
    },
  };

  for (const [screen, { path, keys }] of Object.entries(screens)) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /useTranslation/);
    for (const key of keys) {
      assert.ok(source.includes(key), `${screen} does not use ${key}`);
    }
  }
});

test("changing language preserves Impostor roles, votes, session identity, and results", async () => {
  const classicSession = { id: "classic-session", roomCode: "ABCD" };
  const classicRole = { sessionId: classicSession.id, role: "impostor" };
  const classicResult = { outcome: "win", winnerPlayerIds: ["player-1"] };
  const wordSession = { id: "word-session", roomCode: "EFGH" };
  const wordRole = { sessionId: wordSession.id, role: "civilian" };
  const wordResult = { outcome: "draw", winnerPlayerIds: [] };
  const room = { code: "ABCD", gameStatus: "finished" };

  useClassicGameStore.setState({
    session: classicSession,
    role: classicRole,
    selectedTargetId: "player-2",
    submittedVoteKey: "classic-vote-phase",
    voteSent: true,
    result: classicResult,
  });
  useWordGameStore.setState({
    session: wordSession,
    role: wordRole,
    selectedTargetId: "player-3",
    submittedVoteKey: "word-vote-phase",
    voteSent: true,
    result: wordResult,
  });
  useRoomStore.setState({ room });

  try {
    const languageStore = createLanguageStore(createMemoryStorage());
    const textBefore = translate(
      languageStore.getState().language,
      "impostor.vote.submit",
    );
    await languageStore.getState().setLanguage("it");
    const textAfter = translate(
      languageStore.getState().language,
      "impostor.vote.submit",
    );
    assert.equal(textBefore, "Submit vote");
    assert.equal(textAfter, "Invia voto");

    const classicAfter = useClassicGameStore.getState();
    const wordAfter = useWordGameStore.getState();
    assert.strictEqual(classicAfter.session, classicSession);
    assert.strictEqual(classicAfter.role, classicRole);
    assert.strictEqual(classicAfter.result, classicResult);
    assert.equal(classicAfter.selectedTargetId, "player-2");
    assert.equal(classicAfter.submittedVoteKey, "classic-vote-phase");
    assert.equal(classicAfter.voteSent, true);
    assert.strictEqual(wordAfter.session, wordSession);
    assert.strictEqual(wordAfter.role, wordRole);
    assert.strictEqual(wordAfter.result, wordResult);
    assert.equal(wordAfter.selectedTargetId, "player-3");
    assert.equal(wordAfter.submittedVoteKey, "word-vote-phase");
    assert.equal(wordAfter.voteSent, true);
    assert.strictEqual(useRoomStore.getState().room, room);
    assert.equal(useRoomStore.getState().room.gameStatus, "finished");
  } finally {
    useClassicGameStore.getState().reset();
    useWordGameStore.getState().reset();
    useRoomStore.getState().clearSession();
  }
});

test("all four catalogs contain the complete Manhunt gameplay localization", () => {
  const manhuntKeys = Object.keys(translations.en).filter((key) =>
    key.startsWith("manhunt."),
  );
  const placeholders = (message) =>
    [...message.matchAll(/\{([^}]+)\}/g)]
      .map((match) => match[1])
      .sort();

  assert.ok(manhuntKeys.length > 100);
  for (const language of ["en", "es", "fr", "it"]) {
    for (const key of manhuntKeys) {
      assert.ok(translations[language][key], `${language} is missing ${key}`);
    }
  }

  for (const language of ["es", "fr", "it"]) {
    for (const key of manhuntKeys) {
      assert.deepEqual(
        placeholders(translations[language][key]),
        placeholders(translations.en[key]),
        `${language} changed interpolation variables for ${key}`,
      );
    }
  }
});

test("Manhunt messages fall back to English and interpolate in every language", () => {
  const fallbackKey = "manhunt.catch.message";
  const fallbackValues = { hunter: "Hidden Fox" };
  assert.equal(
    translate("fr", fallbackKey, fallbackValues, { fr: {} }),
    translate("en", fallbackKey, fallbackValues),
  );

  const sampleKeys = [
    "manhunt.catch.message",
    "manhunt.map.missionInstructions",
    "manhunt.setup.center",
    "manhunt.error.locationPosition",
  ];
  for (const language of ["en", "es", "fr", "it"]) {
    for (const key of sampleKeys) {
      const values = Object.fromEntries(
        [...translations.en[key].matchAll(/\{([^}]+)\}/g)].map((match) => [
          match[1],
          match[1] === "hunter" ? "Hidden Fox" : 42,
        ]),
      );
      const rendered = translate(language, key, values);
      assert.doesNotMatch(rendered, /\{[^}]+\}/);
      for (const value of Object.values(values)) {
        assert.ok(rendered.includes(String(value)));
      }
    }
  }
});

test("Manhunt errors translate recognized messages and preserve unknown details", () => {
  for (const language of ["en", "es", "fr", "it"]) {
    const t = (key, values) => translate(language, key, values);
    assert.equal(
      localizeManhuntError("That runner is no longer available.", t),
      t("manhunt.error.runnerUnavailable"),
    );
    const gpsDetail =
      "Could not get a usable GPS position. Move to a more open area and try again. Native GPS detail";
    assert.ok(
      localizeManhuntError(gpsDetail, t).includes("Native GPS detail"),
    );
    const unknown = "MANHUNT_SERVER_ERROR: custom server detail";
    assert.equal(localizeManhuntError(unknown, t), unknown);
  }
});

test("Manhunt screens and shared UI use catalog-backed copy", async () => {
  const screens = {
    mode: {
      path: "../app/manhunt/mode.tsx",
      keys: ["manhunt.mode.description", "manhunt.mode.continue"],
    },
    setup: {
      path: "../app/manhunt/setup.tsx",
      keys: ["manhunt.setup.location.requesting", "manhunt.setup.reveals"],
    },
    countdown: {
      path: "../app/manhunt/countdown.tsx",
      keys: ["manhunt.countdown.headStart", "manhunt.countdown.mapOpens"],
    },
    map: {
      path: "../app/manhunt/map.tsx",
      keys: [
        "manhunt.map.missionInstructions",
        "manhunt.map.runnerPrivacy",
        "manhunt.map.ability.usesRemaining",
        "manhunt.map.catchStatus.pending",
      ],
    },
    results: {
      path: "../app/manhunt/results.tsx",
      keys: ["manhunt.results.caught", "manhunt.results.backToRoom"],
    },
    boundaryPreview: {
      path: "../src/components/ManhuntBoundaryPreview.tsx",
      keys: ["manhunt.preview.title", "manhunt.preview.recenter"],
    },
    catchModal: {
      path: "../src/components/ManhuntCatchConfirmationModal.tsx",
      keys: ["manhunt.catch.message", "manhunt.catch.accept"],
    },
    catchAnnouncement: {
      path: "../src/components/CatchAnnouncementBanner.tsx",
      keys: ["manhunt.map.catchAnnouncement"],
    },
  };

  for (const [screen, { path, keys }] of Object.entries(screens)) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /useTranslation/, `${screen} does not subscribe to language changes`);
    for (const key of keys) {
      assert.ok(source.includes(key), `${screen} does not use ${key}`);
    }
  }
});

test("shared app surfaces and components use localized labels and known errors", async () => {
  const files = [
    {
      path: "../src/components/CodeInput.tsx",
      keys: ["common.roomCodeCharacter", "useTranslation"],
    },
    {
      path: "../app/_layout.tsx",
      keys: [
        "shared.font.loadFailureTitle",
        "shared.font.timeoutMessage",
        "shared.font.loading",
      ],
    },
    {
      path: "../app/index.tsx",
      keys: ["localizeSharedError", "connectionHint"],
    },
    {
      path: "../app/join.tsx",
      keys: ["localizeSharedError", "localizedLookupError"],
    },
    {
      path: "../app/lobby.tsx",
      keys: [
        "localizeSharedError",
        "localizeActivity",
        "localizeNotice",
        "lobby.joinedActivity",
        "lobby.leftActivity",
        "lobby.connection.reconnecting",
      ],
    },
  ];

  for (const { path, keys } of files) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    for (const key of keys) {
      assert.ok(source.includes(key), `${path} does not use ${key}`);
    }
  }

  const codeInput = await readFile(
    new URL("../src/components/CodeInput.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(codeInput, /Room code character/);
});

test("changing language preserves Manhunt session, role, locations, mission, and ability state", async () => {
  const session = {
    id: "manhunt-session",
    roomCode: "MNHT",
    gameMode: "manhunt",
    state: {
      phase: "active",
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 12.5, longitude: -40.25 },
          radiusMeters: 500,
        },
      },
    },
  };
  const locationReveal = {
    sessionId: session.id,
    roomCode: session.roomCode,
    locations: [{ playerId: "hunter-id", coordinates: { latitude: 12, longitude: -40 } }],
  };
  const missionAssignment = {
    sessionId: session.id,
    playerId: "runner-id",
    status: "active",
    center: { latitude: 12.4, longitude: -40.2 },
  };
  const footstepsState = { remainingUses: 2 };
  const smokeBombState = { remainingUses: 1 };
  const freezeDecoyUsageState = { remainingUses: 3 };

  useManhuntGameStore.getState().reset();
  useManhuntGameStore.setState({
    session,
    gameState: session.state,
    ownTeam: "runner",
    ownPlayerId: "runner-id",
    reveal: locationReveal,
    missionAssignment,
    footstepsState,
    smokeBombState,
    freezeDecoyUsageState,
  });
  const languageStore = createLanguageStore(createMemoryStorage());

  try {
    await languageStore.getState().setLanguage("fr");
    const after = useManhuntGameStore.getState();
    assert.strictEqual(after.session, session);
    assert.strictEqual(after.gameState, session.state);
    assert.equal(after.ownTeam, "runner");
    assert.equal(after.ownPlayerId, "runner-id");
    assert.strictEqual(after.reveal, locationReveal);
    assert.strictEqual(after.missionAssignment, missionAssignment);
    assert.strictEqual(after.footstepsState, footstepsState);
    assert.strictEqual(after.smokeBombState, smokeBombState);
    assert.strictEqual(after.freezeDecoyUsageState, freezeDecoyUsageState);
    assert.equal(
      translate(languageStore.getState().language, "manhunt.map.runnerPrivacy"),
      translations.fr["manhunt.map.runnerPrivacy"],
    );
  } finally {
    useManhuntGameStore.getState().reset();
  }
});
