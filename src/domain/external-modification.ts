import type {
  ExternalModificationObservation,
  ReadOnlyDegradationDecision,
} from "./types";

export const isUnsupportedExternalModification = ({
  controlSurface,
}: ExternalModificationObservation) => {
  return controlSurface !== "discord" && controlSurface !== "codex-remote";
};

export const shouldDegradeDiscordToReadOnly = ({
  unsupportedExternalModificationDetected,
}: ReadOnlyDegradationDecision) => {
  return unsupportedExternalModificationDetected;
};
