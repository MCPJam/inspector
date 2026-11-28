import { describe, expect, it } from "vitest";
import { MessagePreparations } from "../message-preparations.js";
const record = {
  actorId: "actor",
  projectId: "project",
  subject: "subject",
  hostId: "host",
  serverId: "server",
  toolName: "tool",
  revision: "revision",
  intentDigest: "digest",
};
const identity = {
  actorId: "actor",
  projectId: "project",
  subject: "subject",
  hostId: "host",
  intentDigest: "digest",
};
const signal = new AbortController().signal;
describe("new-chat message transfer", () => {
  it.each([
    "actorId",
    "projectId",
    "subject",
    "hostId",
    "intentDigest",
  ] as const)("refuses a changed %s", async (key) => {
    const store = new MessagePreparations();
    const token = await store.issue(record);
    await expect(
      store.read(token, { ...identity, [key]: "other" }),
    ).rejects.toThrow("INSTANCE_MESSAGE_UNAVAILABLE");
    await expect(
      store.bind(token, { ...identity, [key]: "other" }, "destination"),
    ).rejects.toThrow("INSTANCE_MESSAGE_UNAVAILABLE");
  });
  it("expires without extending its deadline on read or retry", async () => {
    let now = 0;
    const store = new MessagePreparations(() => now);
    const token = await store.issue(record);
    now = 59_999;
    expect((await store.read(token, identity)).revision).toBe("revision");
    await store.bind(token, identity, "destination");
    now++;
    await expect(store.read(token, identity)).rejects.toThrow();
    await expect(store.bind(token, identity, "destination")).rejects.toThrow();
  });
  it("permits only identical destination and message replay", async () => {
    const store = new MessagePreparations();
    const token = await store.issue(record);
    expect(await store.issue(record)).toBe(token);
    await store.bind(token, identity, "destination-message");
    await store.bind(token, identity, "destination-message");
    await expect(
      store.bind(token, identity, "other-message"),
    ).rejects.toThrow();
  });
  it("bounds outstanding transfers and reclaims only expired records", async () => {
    let now = 0;
    const store = new MessagePreparations(() => now);
    for (let i = 0; i < 512; i++)
      await store.issue({ ...record, intentDigest: String(i) });
    await expect(store.issue(record)).rejects.toThrow("INSTANCE_MESSAGE_LIMIT");
    now = 60_000;
    expect(await store.issue(record)).toHaveLength(43);
  });
  it("cannot recover authority from an unknown or restarted receipt", async () => {
    const token = await new MessagePreparations().issue(record);
    await expect(
      new MessagePreparations().read(token, identity, signal),
    ).rejects.toThrow();
  });
});
