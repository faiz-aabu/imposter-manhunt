import type { TranslationKey } from "./locales";
import type { TranslationValues } from "./translate";

type Translate = (key: TranslationKey, values?: TranslationValues) => string;

const localizedErrors: Record<string, TranslationKey> = {
  "Choose a valid play-area center and radius.":
    "manhunt.error.invalidSettings",
  "Could not update Manhunt settings.": "manhunt.error.settingsUpdate",
  "Could not update readiness.": "manhunt.error.readiness",
  "The game could not be started.": "manhunt.error.start",
  "A valid GPS position is not available yet. Retry location and try again.":
    "manhunt.error.gpsNotReady",
  "Could not configure Manhunt.": "manhunt.error.configure",
  "That runner is no longer available.": "manhunt.error.runnerUnavailable",
  "Could not submit the catch.": "manhunt.error.catchSubmit",
  "Could not activate Footsteps.": "manhunt.error.activateFootsteps",
  "Could not activate Smoke Bomb.": "manhunt.error.activateSmokeBomb",
  "Could not activate Ghost.": "manhunt.error.activateGhost",
  "Could not activate Freeze Decoy.": "manhunt.error.activateFreezeDecoy",
  "Could not send your catch response.": "manhunt.error.catchResponse",
  "The map could not be loaded.": "manhunt.error.mapLoad",
  "Turn on device location services and try again.":
    "manhunt.error.locationServices",
  "Could not open the app's location settings.":
    "manhunt.error.locationOpenSettings",
  "Room does not exist.": "manhunt.error.roomNotFound",
  "This room is not configured for Manhunt.": "manhunt.error.modeMismatch",
  "Manhunt settings cannot be changed after a game has started.":
    "manhunt.error.settingsLocked",
  "Manhunt settings require manhunt mode.": "manhunt.error.settingsMode",
  "Manhunt countdown was not created.": "manhunt.error.countdownMissing",
  "Cannot emit an unrevealed Manhunt mission assignment.":
    "manhunt.error.missionUnrevealed",
  "Manhunt countdown is missing its server deadline.":
    "manhunt.error.countdownDeadline",
  "Late-game exposure target selection was invalid.":
    "manhunt.error.exposureTarget",
};

export function localizeManhuntError(
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

  const gpsPosition = message.match(
    /^Could not get a usable GPS position\. Move to a more open area and try again\.(.*)$/,
  );
  if (gpsPosition) {
    return t("manhunt.error.locationPosition", {
      detail: gpsPosition[1] ?? "",
    });
  }

  const locationRetrieval = message.match(/^Location retrieval failed: (.*)$/);
  if (locationRetrieval) {
    return t("manhunt.error.locationRetrieval", {
      detail: locationRetrieval[1] ?? "",
    });
  }

  return message;
}
