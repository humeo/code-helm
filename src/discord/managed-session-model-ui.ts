const managedModelCustomIdPrefix = "msm";

export const managedModelCustomId = ({
  channelId,
  model,
}: {
  channelId: string;
  model: string;
}) => {
  return `${managedModelCustomIdPrefix}|effort|${channelId}|${model}`;
};

export const parseManagedModelCustomId = (customId: string) => {
  const [prefix, kind, channelId, model] = customId.split("|");

  if (prefix !== managedModelCustomIdPrefix || !channelId) {
    return null;
  }

  if (kind === "model") {
    return {
      channelId,
    } as const;
  }

  if (kind === "effort" && model) {
    return {
      channelId,
      model,
    } as const;
  }

  return null;
};
