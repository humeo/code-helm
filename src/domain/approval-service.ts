import { canControlSession } from "./session-service";
import type { SessionOwnership } from "./types";

export const shouldShowApprovalControls = (ownership: SessionOwnership) => {
  return canControlSession(ownership);
};
