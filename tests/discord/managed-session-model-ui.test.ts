import { expect, test } from "bun:test";
import {
  buildManagedEffortPickerRow,
  buildManagedModelPickerRow,
  managedModelCustomId,
  parseManagedModelCustomId,
} from "../../src/discord/managed-session-model-ui";

test("managed model custom ids stay compact and round-trip through parsing", () => {
  const modelCustomId = managedModelCustomId({
    kind: "model",
    channelId: "discord-1",
  });
  const effortCustomId = managedModelCustomId({
    kind: "effort",
    channelId: "discord-1",
    model: "gpt-5.4",
  });

  expect(modelCustomId.length).toBeLessThanOrEqual(100);
  expect(effortCustomId.length).toBeLessThanOrEqual(100);
  expect(parseManagedModelCustomId(modelCustomId)).toEqual({
    kind: "model",
    channelId: "discord-1",
  });
  expect(parseManagedModelCustomId(effortCustomId)).toEqual({
    kind: "effort",
    channelId: "discord-1",
    model: "gpt-5.4",
  });
});

test("managed model picker rows build Discord select menus with stable option values", () => {
  const row = buildManagedModelPickerRow({
    channelId: "discord-1",
    currentModel: "gpt-5.4",
    models: [
      {
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Frontier model",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
  });

  const payload = row.toJSON();
  const menu = payload.components[0];

  expect(menu.custom_id).toBe("msm|model|discord-1");
  expect(menu.options).toEqual([
    {
      label: "GPT-5.4",
      value: "gpt-5.4",
      description: "Frontier model",
      default: true,
    },
  ]);
});

test("managed effort picker rows build a compact follow-up selector", () => {
  const row = buildManagedEffortPickerRow({
    channelId: "discord-1",
    model: "gpt-5.4",
    currentEffort: "xhigh",
    efforts: ["medium", "high", "xhigh"],
  });

  const payload = row.toJSON();
  const menu = payload.components[0];

  expect(menu.custom_id).toBe("msm|effort|discord-1|gpt-5.4");
  expect(menu.options.map((option) => option.value)).toEqual([
    "medium",
    "high",
    "xhigh",
  ]);
  expect(menu.options.at(-1)?.default).toBe(true);
});
