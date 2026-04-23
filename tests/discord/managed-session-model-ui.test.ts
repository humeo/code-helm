import { expect, test } from "bun:test";
import {
  parseManagedModelCustomId,
} from "../../src/discord/managed-session-model-ui";

test("legacy managed model custom ids still parse for graceful fallback replies", () => {
  expect(parseManagedModelCustomId("msm|model|discord-1")).toEqual({
    channelId: "discord-1",
  });
  expect(parseManagedModelCustomId("msm|effort|discord-1|gpt-5.4")).toEqual({
    channelId: "discord-1",
    model: "gpt-5.4",
  });
});

test("only legacy msm custom ids are recognized", () => {
  expect(parseManagedModelCustomId("approval|discord-1")).toBeNull();
  expect(parseManagedModelCustomId("msm")).toBeNull();
  expect(parseManagedModelCustomId("msm|effort|discord-1")).toBeNull();
});
