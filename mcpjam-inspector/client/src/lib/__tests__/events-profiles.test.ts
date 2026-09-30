import { describe, expect, it } from "vitest";
import {
  EVENTS_PROFILES,
  getEventsProfile,
  usableDeliveryModes,
} from "../events-profiles";

describe("events profiles", () => {
  it("offers exactly the two C1 profiles, draft first", () => {
    expect(EVENTS_PROFILES.map((profile) => profile.id)).toEqual([
      "draft@28ec35e",
      "chatgpt@2026-09-30",
    ]);
    expect(getEventsProfile("draft@28ec35e").label).toBe("Draft (28ec35e)");
    expect(getEventsProfile("chatgpt@2026-09-30").label).toBe(
      "ChatGPT (2026-09-30)",
    );
  });

  it("limits delivery modes to what the event advertises AND the profile uses", () => {
    expect(
      usableDeliveryModes(["poll", "push", "webhook"], "draft@28ec35e"),
    ).toEqual(["poll", "push", "webhook"]);
    // ChatGPT only ever registers webhooks.
    expect(
      usableDeliveryModes(["poll", "push", "webhook"], "chatgpt@2026-09-30"),
    ).toEqual(["webhook"]);
    expect(usableDeliveryModes(["poll"], "chatgpt@2026-09-30")).toEqual([]);
    // Unknown modes and duplicates in a descriptor are ignored.
    expect(
      usableDeliveryModes(["sse", "poll", "poll"], "draft@28ec35e"),
    ).toEqual(["poll"]);
  });
});
