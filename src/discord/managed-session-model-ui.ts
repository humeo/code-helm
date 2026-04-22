import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { ModelCatalogEntry } from "../codex/protocol-types";

type ManagedModelCustomIdInput =
  | {
      kind: "model";
      channelId: string;
    }
  | {
      kind: "effort";
      channelId: string;
      model: string;
    };

const managedModelCustomIdPrefix = "msm";

const truncate = (value: string, maxLength: number) => {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
};

export const managedModelCustomId = (input: ManagedModelCustomIdInput) => {
  return input.kind === "model"
    ? `${managedModelCustomIdPrefix}|model|${input.channelId}`
    : `${managedModelCustomIdPrefix}|effort|${input.channelId}|${input.model}`;
};

export const parseManagedModelCustomId = (customId: string) => {
  const [prefix, kind, channelId, model] = customId.split("|");

  if (prefix !== managedModelCustomIdPrefix || !channelId) {
    return null;
  }

  if (kind === "model") {
    return {
      kind,
      channelId,
    } as const;
  }

  if (kind === "effort" && model) {
    return {
      kind,
      channelId,
      model,
    } as const;
  }

  return null;
};

const buildSelectOptions = ({
  label,
  value,
  description,
  selected,
}: {
  label: string;
  value: string;
  description?: string;
  selected?: boolean;
}) => {
  const option: {
    label: string;
    value: string;
    description?: string;
    default?: boolean;
  } = {
    label: truncate(label, 100),
    value: truncate(value, 100),
  };

  if (description) {
    option.description = truncate(description, 100);
  }

  if (selected) {
    option.default = true;
  }

  return option;
};

export const buildManagedModelPickerRow = ({
  channelId,
  currentModel,
  models,
}: {
  channelId: string;
  currentModel?: string | null;
  models: ModelCatalogEntry[];
}) => {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(managedModelCustomId({
        kind: "model",
        channelId,
      }))
      .setPlaceholder("Select a model")
      .addOptions(
        models.slice(0, 25).map((model) =>
          buildSelectOptions({
            label: model.displayName,
            value: model.model,
            description: model.description,
            selected: model.model === currentModel,
          })
        ),
      ),
  );
};

export const buildManagedEffortPickerRow = ({
  channelId,
  model,
  currentEffort,
  efforts,
}: {
  channelId: string;
  model: string;
  currentEffort?: string | null;
  efforts: string[];
}) => {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(managedModelCustomId({
        kind: "effort",
        channelId,
        model,
      }))
      .setPlaceholder("Select a reasoning effort")
      .addOptions(
        efforts.slice(0, 25).map((effort) =>
          buildSelectOptions({
            label: effort,
            value: effort,
            selected: effort === currentEffort,
          })
        ),
      ),
  );
};
