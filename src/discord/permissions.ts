import { canControlSession as canControlDomainSession } from "../domain/session-service";

export type DiscordSessionControl = {
  actorId: string;
  ownerId: string;
};

export const canControlSession = ({
  actorId,
  ownerId,
}: DiscordSessionControl) => {
  return canControlDomainSession({ viewerId: actorId, ownerId });
};
