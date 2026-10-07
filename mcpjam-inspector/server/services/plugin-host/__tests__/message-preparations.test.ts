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
describe("new-chat message transfer", () => {
  it.each([
    "actorId",
    "projectId",
    "subject",
    "hostId",
    "intentDigest",
  ] as const)("refuses a changed %s", (key) => {
    const store = new MessagePreparations();
    const token = store.issue(record);
    expect(() => store.read(token, { ...identity, [key]: "other" })).toThrow(
      "INSTANCE_MESSAGE_UNAVAILABLE",
    );
  });
  it("expires without extending its deadline on read or retry", () => {
    let now = 0;
    const store = new MessagePreparations(() => now);
    const token = store.issue(record);
    now = 59_999;
    expect(store.read(token, identity).revision).toBe("revision");
    store.bind(token, "destination");
    now++;
    expect(() => store.read(token, identity)).toThrow();
    expect(() => store.bind(token, "destination")).toThrow();
  });
  it("permits only identical destination and message replay", () => {
    const store = new MessagePreparations();
    const token = store.issue(record);
    expect(store.issue(record)).toBe(token);
    store.bind(token, "destination-message");
    store.bind(token, "destination-message");
    expect(() => store.bind(token, "other-message")).toThrow();
  });
  it("bounds outstanding transfers and reclaims only expired records", () => {
    let now = 0;
    const store = new MessagePreparations(() => now);
    for (let i = 0; i < 512; i++)
      store.issue({ ...record, intentDigest: String(i) });
    expect(() => store.issue(record)).toThrow("INSTANCE_MESSAGE_LIMIT");
    now = 60_000;
    expect(store.issue(record)).toHaveLength(43);
  });
  it("cannot recover authority from an unknown or restarted receipt", () => {
    const token = new MessagePreparations().issue(record);
    expect(() => new MessagePreparations().read(token, identity)).toThrow();
  });
});
