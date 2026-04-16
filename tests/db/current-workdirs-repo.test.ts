import { expect, test } from "bun:test";
import { createDatabaseClient } from "../../src/db/client";
import { applyMigrations } from "../../src/db/migrate";
import { createCurrentWorkdirRepo } from "../../src/db/repos/current-workdirs";

const createMigratedDb = () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  return db;
};

test("stores and reads a current workdir row", () => {
  const db = createMigratedDb();
  const repo = createCurrentWorkdirRepo(db);

  repo.upsert({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u1",
    cwd: "/tmp/ws1/app",
  });

  expect(
    repo.get({
      guildId: "g1",
      channelId: "c1",
      discordUserId: "u1",
    }),
  ).toMatchObject({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u1",
    cwd: "/tmp/ws1/app",
  });

  db.close();
});

test("upserting the same guild channel and user updates cwd", () => {
  const db = createMigratedDb();
  const repo = createCurrentWorkdirRepo(db);

  repo.upsert({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u1",
    cwd: "/tmp/ws1/app",
  });
  repo.upsert({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u1",
    cwd: "/tmp/ws1/api",
  });

  expect(
    repo.get({
      guildId: "g1",
      channelId: "c1",
      discordUserId: "u1",
    })?.cwd,
  ).toBe("/tmp/ws1/api");

  db.close();
});

test("different users in the same channel do not share workdirs", () => {
  const db = createMigratedDb();
  const repo = createCurrentWorkdirRepo(db);

  repo.upsert({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u1",
    cwd: "/tmp/ws1/app",
  });
  repo.upsert({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u2",
    cwd: "/tmp/ws1/api",
  });

  expect(
    repo.get({
      guildId: "g1",
      channelId: "c1",
      discordUserId: "u1",
    })?.cwd,
  ).toBe("/tmp/ws1/app");
  expect(
    repo.get({
      guildId: "g1",
      channelId: "c1",
      discordUserId: "u2",
    })?.cwd,
  ).toBe("/tmp/ws1/api");

  db.close();
});

test("the same user in different channels does not share workdirs", () => {
  const db = createMigratedDb();
  const repo = createCurrentWorkdirRepo(db);

  repo.upsert({
    guildId: "g1",
    channelId: "c1",
    discordUserId: "u1",
    cwd: "/tmp/ws1/app",
  });
  repo.upsert({
    guildId: "g1",
    channelId: "c2",
    discordUserId: "u1",
    cwd: "/tmp/ws1/api",
  });

  expect(
    repo.get({
      guildId: "g1",
      channelId: "c1",
      discordUserId: "u1",
    })?.cwd,
  ).toBe("/tmp/ws1/app");
  expect(
    repo.get({
      guildId: "g1",
      channelId: "c2",
      discordUserId: "u1",
    })?.cwd,
  ).toBe("/tmp/ws1/api");

  db.close();
});
