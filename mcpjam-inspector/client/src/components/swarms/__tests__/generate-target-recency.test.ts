import { describe, expect, it } from "vitest";
import {
  attachmentConnectedAt,
  mostRecentlyConnectedAttachmentId,
} from "../generate-target-recency";

const group = (id: string, ...names: string[]) => ({
  _id: id,
  resolvedServerNames: names,
});

const at = (iso: string) => ({ lastConnectionTime: new Date(iso) });

describe("mostRecentlyConnectedAttachmentId", () => {
  it("picks the group whose server connected last", () => {
    const servers = {
      alpha: at("2026-08-01T10:00:00Z"),
      beta: at("2026-08-29T10:00:00Z"),
    };
    expect(
      mostRecentlyConnectedAttachmentId(
        [group("att-1", "alpha"), group("att-2", "beta")],
        servers
      )
    ).toBe("att-2");
  });

  it("rates a group by its newest member, not its oldest", () => {
    const servers = {
      stale: at("2026-01-01T00:00:00Z"),
      fresh: at("2026-08-29T00:00:00Z"),
    };
    expect(attachmentConnectedAt(group("att-1", "stale", "fresh"), servers)).toBe(
      new Date("2026-08-29T00:00:00Z").getTime()
    );
  });

  it("returns null when nothing has ever connected", () => {
    expect(
      mostRecentlyConnectedAttachmentId([group("att-1", "alpha")], {})
    ).toBeNull();
  });

  it("returns null outside an AppStateProvider", () => {
    expect(
      mostRecentlyConnectedAttachmentId([group("att-1", "alpha")], undefined)
    ).toBeNull();
  });

  it("ignores a group whose servers are unknown to the runtime", () => {
    const servers = { alpha: at("2026-08-29T10:00:00Z") };
    expect(
      mostRecentlyConnectedAttachmentId(
        [group("att-ghost", "not-connected-yet"), group("att-1", "alpha")],
        servers
      )
    ).toBe("att-1");
  });

  it("survives an unparseable timestamp instead of ordering on NaN", () => {
    const servers = {
      broken: { lastConnectionTime: "not a date" },
      alpha: at("2026-08-01T10:00:00Z"),
    };
    expect(
      mostRecentlyConnectedAttachmentId(
        [group("att-broken", "broken"), group("att-1", "alpha")],
        servers
      )
    ).toBe("att-1");
  });

  it("keeps a stable answer when two groups share the newest server", () => {
    const servers = { shared: at("2026-08-29T10:00:00Z") };
    const groups = [group("att-1", "shared"), group("att-2", "shared")];
    expect(mostRecentlyConnectedAttachmentId(groups, servers)).toBe("att-1");
    expect(mostRecentlyConnectedAttachmentId(groups, servers)).toBe("att-1");
  });
});
