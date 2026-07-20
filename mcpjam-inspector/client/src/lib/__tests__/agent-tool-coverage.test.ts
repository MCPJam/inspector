/**
 * Agent-tool coverage: every surface manifest carries an explicit, enforced
 * `agentTools` decision, and each kind's obligations actually hold.
 *
 * The point of this file: a surface cannot ship half-wired. Declaring
 * `kind: "group"` without a `SURFACE_TOOL_GROUPS` entry (or vice versa),
 * without a bridge call in its own component, or with tools that would be
 * silently dropped at the chat boundary — all fail HERE, not in a chat
 * transcript. Two house styles combined: static data imports
 * (app-surface-coverage.test.ts) and readFileSync string-matching
 * (surface-snapshot-coverage.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAppAtlas,
  getAppSurface,
  listAppSurfaces,
} from "@/shared/app-surfaces";
import { UI_TOOL_NAME_REGEX } from "@/shared/client-fulfilled-tools.js";
import {
  SURFACE_TOOL_GROUPS,
  listSurfaceGroupToolNames,
} from "@/lib/webmcp/groups";
import { buildUiToolsCatalog } from "@/lib/webmcp/ui-tools-catalog";
import type { UiToolDefinition } from "@/lib/webmcp/ui-tools-registry";
import { BRIDGE_MODULES } from "./agent-bridge-modules";

const repoRoot = join(__dirname, "../../../..");

const surfaces = listAppSurfaces();
const groupSurfaceIds = surfaces
  .filter((s) => s.agentTools.kind === "group")
  .map((s) => s.id)
  .sort();

describe("agentTools kind ↔ SURFACE_TOOL_GROUPS", () => {
  it('every kind:"group" surface has a tool group registered', () => {
    for (const id of groupSurfaceIds) {
      expect(
        SURFACE_TOOL_GROUPS[id as keyof typeof SURFACE_TOOL_GROUPS],
        `${id} declares agentTools.kind "group" but has no SURFACE_TOOL_GROUPS entry`,
      ).toBeDefined();
    }
  });

  it('every tool group belongs to a kind:"group" surface', () => {
    for (const [id, group] of Object.entries(SURFACE_TOOL_GROUPS)) {
      expect(group?.surfaceId, `group key ${id}`).toBe(id);
      const surface = getAppSurface(id);
      expect(surface, `group "${id}" names an unknown surface`).toBeDefined();
      expect(
        surface?.agentTools.kind,
        `surface ${id} has a tool group but its manifest doesn't declare kind "group"`,
      ).toBe("group");
    }
  });

  it("listSurfaceGroupToolNames is empty for unknown and group-less surfaces", () => {
    expect(listSurfaceGroupToolNames("home")).toEqual([]);
    expect(listSurfaceGroupToolNames("not-a-surface")).toEqual([]);
  });
});

describe("the global catalog set is frozen", () => {
  it('kind:"global" is exactly playground + servers', () => {
    // Expanding the always-on catalog is a conscious edit HERE, not a side
    // effect of a new manifest: every global tool costs context on every
    // chat POST from every screen, and the whole surface-group design
    // exists so new surfaces don't pay that. New surfaces use kind "group".
    const globals = surfaces
      .filter((s) => s.agentTools.kind === "global")
      .map((s) => s.id)
      .sort();
    expect(globals).toEqual(["playground", "servers"]);
  });
});

describe("group surfaces wire the bridge in their own component", () => {
  it("every group surface has a BRIDGE_MODULES row", () => {
    for (const id of groupSurfaceIds) {
      expect(
        BRIDGE_MODULES[id],
        `${id} needs a BRIDGE_MODULES entry pointing at the component that calls useSurfaceAgentBridge`,
      ).toBeDefined();
    }
  });

  it("every bridge module calls useSurfaceAgentBridge with its own literal id", () => {
    for (const [surfaceId, modulePath] of Object.entries(BRIDGE_MODULES)) {
      const source = readFileSync(join(repoRoot, modulePath), "utf-8");
      expect(
        source,
        `${modulePath} must call useSurfaceAgentBridge`,
      ).toContain("useSurfaceAgentBridge");
      expect(
        source,
        `${modulePath} must pass surfaceId: "${surfaceId}" (a literal, not a variable — shared hooks can't do this honestly)`,
      ).toContain(`surfaceId: "${surfaceId}"`);
    }
  });

  it("every group surface claims a snapshot provider (the bridge registers one)", () => {
    // Operating a screen without being able to observe it invites blind
    // retries; a tool group and a snapshot provider ship together.
    for (const id of groupSurfaceIds) {
      expect(
        getAppSurface(id)?.hasSnapshotProvider,
        `${id} has a tool group but hasSnapshotProvider is not true`,
      ).toBe(true);
    }
  });

  it("no BRIDGE_MODULES row exists for a non-group surface", () => {
    for (const surfaceId of Object.keys(BRIDGE_MODULES)) {
      expect(
        getAppSurface(surfaceId)?.agentTools.kind,
        `BRIDGE_MODULES maps "${surfaceId}" but its manifest is not kind "group"`,
      ).toBe("group");
    }
  });
});

describe("tool hygiene: global catalog + every group", () => {
  // Every definition that can ever reach snapshotForChatBody.
  const sets: Array<[label: string, tools: UiToolDefinition[]]> = [
    ["global catalog", buildUiToolsCatalog()],
    ...Object.entries(SURFACE_TOOL_GROUPS).map(
      ([id, group]): [string, UiToolDefinition[]] => [
        `group:${id}`,
        group?.buildTools() ?? [],
      ],
    ),
  ];
  const allTools = sets.flatMap(([label, tools]) =>
    tools.map((tool) => ({ label, tool })),
  );

  it("names match UI_TOOL_NAME_REGEX and are unique across globals and all groups", () => {
    // Pairwise across EVERYTHING: a group tool that collides with a global
    // (or another group's) name would hit the registry's live-collision
    // guard at runtime — dev-server throw, prod warn+replace. Catch it here.
    const seen = new Map<string, string>();
    for (const { label, tool } of allTools) {
      expect(tool.name, `${label}/${tool.name}`).toMatch(UI_TOOL_NAME_REGEX);
      expect(
        seen.get(tool.name),
        `"${tool.name}" defined in both ${seen.get(tool.name)} and ${label}`,
      ).toBeUndefined();
      seen.set(tool.name, label);
    }
  });

  it("descriptions and schemas fit the server caps — nothing gets silently dropped", () => {
    // This is the ONLY guard against snapshotForChatBody's silent drop: an
    // oversized inputSchema (or a snapshot past 64 entries) is skipped at
    // POST time with nothing but a console.warn, so the model simply never
    // sees the tool. Enforce the caps at build time instead.
    for (const { label, tool } of allTools) {
      expect(
        tool.description.length,
        `${label}/${tool.name} description`,
      ).toBeLessThanOrEqual(512);
      if (tool.inputSchema) {
        const bytes = new TextEncoder().encode(
          JSON.stringify(tool.inputSchema),
        ).length;
        expect(bytes, `${label}/${tool.name} inputSchema bytes`).toBeLessThanOrEqual(
          8 * 1024,
        );
      }
    }
  });

  it("every tool carries a complete annotations object agreeing with readOnly", () => {
    for (const { label, tool } of allTools) {
      const annotations = tool.annotations;
      expect(annotations, `${label}/${tool.name} must annotate`).toBeDefined();
      expect(typeof annotations?.readOnlyHint, `${label}/${tool.name}`).toBe(
        "boolean",
      );
      expect(typeof annotations?.destructiveHint, `${label}/${tool.name}`).toBe(
        "boolean",
      );
      expect(typeof annotations?.idempotentHint, `${label}/${tool.name}`).toBe(
        "boolean",
      );
      expect(typeof annotations?.openWorldHint, `${label}/${tool.name}`).toBe(
        "boolean",
      );
      expect(annotations?.readOnlyHint, `${label}/${tool.name}`).toBe(
        tool.readOnly,
      );
    }
  });

  it("catalog + the largest group fit the snapshot budget with headroom", () => {
    // 56 = 8 headroom under the server's 64-entry snapshot cap, assuming a
    // single surface is mounted at a time (one group live alongside the
    // global catalog). If this trips, trim tools — don't raise the budget
    // without also revisiting the cap and the single-mount assumption.
    const groupSizes = Object.values(SURFACE_TOOL_GROUPS).map(
      (group) => group?.buildTools().length ?? 0,
    );
    const largestGroup = groupSizes.length > 0 ? Math.max(...groupSizes) : 0;
    expect(buildUiToolsCatalog().length + largestGroup).toBeLessThanOrEqual(56);
  });
});

describe('kind:"none" opt-outs are real decisions', () => {
  it("every reason is specific enough to review (≥ 20 chars)", () => {
    for (const surface of surfaces) {
      if (surface.agentTools.kind !== "none") continue;
      expect(
        surface.agentTools.reason.trim().length,
        `${surface.id} reason: "${surface.agentTools.reason}"`,
      ).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("atlas advertises the group mechanism", () => {
  it("tells the model navigation can unlock screen-specific tools", () => {
    expect(buildAppAtlas()).toContain(
      "Navigating to a screen can make additional screen-specific agent tools available on your next step.",
    );
  });

  it("stays a reasonable size for a system prompt", () => {
    // Determinism/stability is already covered by app-surface-coverage's
    // atlas tests; this only rechecks the size after the added line.
    expect(buildAppAtlas({ hosted: true }).length).toBeLessThan(12_000);
  });
});
