import type {
  ExternalModificationObservation,
} from "./types";

export const isUnsupportedExternalModification = ({
  controlSurface,
}: ExternalModificationObservation) => {
  return controlSurface !== "discord" && controlSurface !== "codex-remote";
};

export const shouldDegradeDiscordToReadOnly = ({
  controlSurface,
}: ExternalModificationObservation) => {
  return controlSurface === "plain-codex" || controlSurface === "unknown";
};
