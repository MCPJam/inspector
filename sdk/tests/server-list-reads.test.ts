import { describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { EventDescriptorWire } from "../src/mcp-client-manager/events-ext-schemas.js";
import {
  readServerEventTypes,
  readServerSkillCatalog,
} from "../src/server-list-reads.js";

const event = (name: string, delivery: string[]): EventDescriptorWire => ({
  name,
  delivery,
});

function eventsManager(
  pages: Record<string, { events: EventDescriptorWire[]; nextCursor?: string } | Error>
) {
  const manager = new MCPClientManager();
  const listServerEvents = vi
    .spyOn(manager, "listServerEvents")
    .mockImplementation(async (_serverId, params) => {
      const page = pages[params?.cursor ?? "first"];
      if (page instanceof Error) throw page;
      return page;
    });
  return { manager, listServerEvents };
}

describe("readServerEventTypes", () => {
  it("walks pages until the cursor stops and summarizes without server text", async () => {
    const { manager, listServerEvents } = eventsManager({
      first: { events: [event("order.created", ["poll", "webhook"])], nextCursor: "2" },
      "2": { events: [event("order.paid", ["webhook"])], nextCursor: "2" },
    });

    const read = await readServerEventTypes(manager, "srv");

    expect(listServerEvents).toHaveBeenCalledTimes(2);
    expect(read).toEqual({
      status: "listed",
      events: [
        event("order.created", ["poll", "webhook"]),
        event("order.paid", ["webhook"]),
      ],
      truncated: false,
      summary: { eventCount: 2, deliveryModes: ["poll", "webhook"] },
    });
  });

  it("keeps what was read before a page failed", async () => {
    const failure = new Error("Method not found");
    const { manager } = eventsManager({
      first: { events: [event("a", ["poll"])], nextCursor: "2" },
      "2": failure,
    });

    const read = await readServerEventTypes(manager, "srv");

    expect(read.status).toBe("failed");
    expect(read.error).toBe(failure);
    expect(read.events.map((entry) => entry.name)).toEqual(["a"]);
  });

  it("sends the signal with every page and stops paging once it aborts", async () => {
    const controller = new AbortController();
    const { manager, listServerEvents } = eventsManager({});
    listServerEvents.mockImplementation(async (_serverId, params) => {
      if (params?.cursor === undefined) {
        return { events: [event("a", ["poll"])], nextCursor: "2" };
      }
      // The budget runs out while the second page is in flight.
      controller.abort();
      return { events: [event("b", ["poll"])], nextCursor: "3" };
    });

    const read = await readServerEventTypes(manager, "srv", {
      signal: controller.signal,
    });

    expect(listServerEvents).toHaveBeenCalledTimes(2);
    for (const call of listServerEvents.mock.calls) {
      expect(call[2]?.signal).toBe(controller.signal);
    }
    expect(read.status).toBe("failed");
    expect(read.events.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("sends nothing when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { manager, listServerEvents } = eventsManager({
      first: { events: [event("a", ["poll"])] },
    });

    const read = await readServerEventTypes(manager, "srv", {
      signal: controller.signal,
    });

    expect(listServerEvents).not.toHaveBeenCalled();
    expect(read).toMatchObject({ status: "failed", events: [] });
  });

  it("marks the listing truncated when the page cap stops it", async () => {
    const { manager, listServerEvents } = eventsManager({
      first: { events: [event("a", ["poll"])], nextCursor: "2" },
      "2": { events: [event("b", ["poll"])], nextCursor: "3" },
    });

    const read = await readServerEventTypes(manager, "srv", { maxPages: 2 });

    expect(listServerEvents).toHaveBeenCalledTimes(2);
    expect(read.truncated).toBe(true);
    expect(read.summary.eventCount).toBe(2);
  });
});

describe("readServerSkillCatalog", () => {
  const support = {
    declared: true,
    advertised: true,
    directoryRead: true,
    active: true,
  };

  it("sends nothing when the extension is not active", async () => {
    const manager = new MCPClientManager();
    vi.spyOn(manager, "getSkillsSupport").mockReturnValue({
      ...support,
      advertised: false,
      active: false,
    });
    const listServerSkills = vi.spyOn(manager, "listServerSkills");

    const read = await readServerSkillCatalog(manager, "srv");

    expect(read.status).toBe("inactive");
    expect(listServerSkills).not.toHaveBeenCalled();
  });

  it("reports no support when the manager cannot say", async () => {
    const manager = new MCPClientManager();
    vi.spyOn(manager, "getSkillsSupport").mockImplementation(() => {
      throw new Error("not connected");
    });
    const read = await readServerSkillCatalog(manager, "srv");
    expect(read).toEqual({ status: "inactive", support: undefined });
  });

  it("lists the catalog and counts what the server cannot serve", async () => {
    const manager = new MCPClientManager();
    vi.spyOn(manager, "getSkillsSupport").mockReturnValue(support);
    vi.spyOn(manager, "listServerSkills").mockResolvedValue({
      skills: [
        {
          uri: "skill://acme/refunds/SKILL.md",
          frontmatter: { name: "refunds", description: "Handle refunds." },
          resources: "dynamic",
        },
        {
          uri: "skill://acme/broken/SKILL.md",
          frontmatter: { name: "other", description: "Mismatched name." },
        },
      ],
      ttlMs: 0,
      cacheScope: "connection",
    });

    const read = await readServerSkillCatalog(manager, "srv");

    expect(read.status).toBe("listed");
    if (read.status !== "listed") return;
    expect(read.summary).toEqual({
      count: 1,
      unloadable: 1,
      rejected: 1,
      directoryRead: true,
    });
    expect(read.listing.skills.map((skill) => skill.skillUri)).toEqual([
      "skill://acme/refunds/SKILL.md",
    ]);
  });

  it("returns a failed listing instead of throwing", async () => {
    const manager = new MCPClientManager();
    vi.spyOn(manager, "getSkillsSupport").mockReturnValue(support);
    const failure = new Error("Method not found");
    vi.spyOn(manager, "listServerSkills").mockRejectedValue(failure);

    expect(await readServerSkillCatalog(manager, "srv")).toEqual({
      status: "failed",
      support,
      error: failure,
    });
  });
});
