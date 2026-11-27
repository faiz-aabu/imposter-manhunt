import type { TranslationKey } from "./locales";
import type { TranslationValues } from "./translate";

type Translate = (key: TranslationKey, values?: TranslationValues) => string;

const localizedErrors: Record<string, TranslationKey> = {
  "Reconnect to the server before requesting your role.":
    "impostor.role.reconnectBeforeRequest",
  "Could not request your role.": "impostor.role.requestFailed",
  "The server did not return your role. Try again.":
    "impostor.role.roleUnavailable",
  "Reconnect before submitting your vote.":
    "impostor.vote.reconnectBeforeSubmit",
  "Your vote could not be sent.": "impostor.vote.sendFailed",
  "Choose valid Word Impostor settings before starting.":
    "impostor.setup.invalidWordSettings",
  "The game could not be started.": "impostor.setup.startFailed",
  "Could not initialize the game connection.":
    "impostor.error.initializeConnection",
  "Could not configure the server connection.":
    "impostor.error.configureConnection",
  "Could not restore the game connection.":
    "impostor.error.restoreConnection",
  "The saved room session is no longer available.":
    "impostor.error.sessionUnavailable",
  "The saved player session does not match this room.":
    "impostor.error.playerMismatch",
  "The requested role is unavailable to this player.":
    "impostor.role.roleUnavailable",
  "Could not synchronize the server clock. Countdown timing is unavailable.":
    "impostor.error.clockSync",
  "Only the host can return this room to the lobby.":
    "impostor.reveal.hostOnlyReturn",
  "The server did not confirm the lobby reset.":
    "impostor.reveal.lobbyResetUnconfirmed",
  "Could not return the room to the lobby.":
    "impostor.reveal.returnFailed",
  "Room does not exist.": "impostor.error.roomNotFound",
  "This room is not configured for Classic Impostor.":
    "impostor.error.classicModeMismatch",
  "This room is not configured for Word Impostor.":
    "impostor.error.wordModeMismatch",
  "All players must be connected before the game can start.":
    "impostor.error.playersNotConnected",
  "Classic Impostor settings are invalid.":
    "impostor.error.classicSettingsInvalid",
  "Word Impostor settings are invalid.":
    "impostor.error.wordSettingsInvalid",
  "A game is already in progress.": "impostor.error.gameInProgress",
  "Only a finished Classic Impostor game can return to the lobby.":
    "impostor.error.returnClassicNotFinished",
  "Only a finished Word Impostor game can return to the lobby.":
    "impostor.error.returnWordNotFinished",
  "Voting is not currently active.": "impostor.error.votingInactive",
  "This player is not eligible to vote.":
    "impostor.error.playerNotEligible",
  "A vote has already been submitted this round.":
    "impostor.error.voteAlreadySubmitted",
  "The selected player is not an eligible vote target.":
    "impostor.error.invalidVoteTarget",
  "Game results are unavailable.":
    "impostor.error.resultsUnavailable",
  "No words are available for the selected category.":
    "impostor.error.wordsUnavailable",
};

export function localizeImpostorError(
  message: string | null,
  t: Translate,
): string | null {
  if (!message) {
    return null;
  }
  const key = localizedErrors[message];
  if (key) {
    return t(key);
  }

  const minimumPlayers = message.match(
    /^(Classic|Word) Impostor requires at least (\d+) players\.$/,
  );
  if (minimumPlayers) {
    return t("impostor.error.minimumPlayers", {
      mode: t(
        minimumPlayers[1] === "Word"
          ? "impostor.mode.word"
          : "impostor.mode.classic",
      ),
      count: Number(minimumPlayers[2]),
    });
  }

  const impostorLimit = message.match(
    /^At most (\d+) impostor\(s\) are valid for this room\.$/,
  );
  if (impostorLimit) {
    const count = Number(impostorLimit[1]);
    return t(
      count === 1
        ? "impostor.error.impostorLimitOne"
        : "impostor.error.impostorLimitMany",
      { count },
    );
  }

  return message;
}
