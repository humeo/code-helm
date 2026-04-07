import type {
  SessionOwnership,
  SessionWorkdirChange,
} from "./types";

export const canImportSession = ({ runtimeState }: { runtimeState: string }) => {
  return runtimeState === "idle";
};

export const canChangeSessionWorkdir = ({
  currentWorkdirId,
  requestedWorkdirId,
}: SessionWorkdirChange) => {
  return currentWorkdirId === requestedWorkdirId;
};

export const canControlSession = ({ viewerId, ownerId }: SessionOwnership) => {
  return viewerId === ownerId;
};
