import { expect, test } from "bun:test";
import { canControlSession } from "../../src/discord/permissions";

test("only thread owner can control the session", () => {
  expect(canControlSession({ actorId: "u1", ownerId: "u1" })).toBe(true);
  expect(canControlSession({ actorId: "u2", ownerId: "u1" })).toBe(false);
});
