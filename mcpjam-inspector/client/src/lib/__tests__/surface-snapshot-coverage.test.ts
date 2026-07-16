/**
 * `hasSnapshotProvider` is a promise the manifest makes to the model: the
 * atlas implies this screen can be observed, and `ui_snapshot_app` will say
 * so. If the wiring is dropped in a refactor the flag keeps claiming it,
 * and the agent gets told a screen reports state that silently doesn't.
 *
 * Full mount tests per surface would need each screen's whole provider tree.
 * This asserts the cheaper half — the flag names a real surface, and the
 * module that registers each flagged provider still does — so a dropped
 * registration surfaces here rather than in a chat transcript.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SURFACES, listAppSurfaces } from "@/shared/app-surfaces";

/** surfaceId → module expected to call `registerSurfaceSnapshotProvider`. */
const PROVIDER_MODULES: Record<string, string> = {
  playground: "client/src/components/ui-playground/hooks/use-playground-state.ts",
};

const repoRoot = join(__dirname, "../../../..");

describe("surfaces that claim a snapshot provider register one", () => {
  const flagged = listAppSurfaces().filter((s) => s.hasSnapshotProvider);

  it("every flagged surface has a known provider module", () => {
    for (const surface of flagged) {
      expect(
        PROVIDER_MODULES[surface.id],
        `${surface.id} claims hasSnapshotProvider but no provider module is mapped here`,
      ).toBeDefined();
    }
  });

  it("every mapped module registers its provider under the surface id", () => {
    for (const [surfaceId, modulePath] of Object.entries(PROVIDER_MODULES)) {
      const source = readFileSync(join(repoRoot, modulePath), "utf-8");
      expect(source, modulePath).toContain("registerSurfaceSnapshotProvider");
      expect(source, `${modulePath} must register as "${surfaceId}"`).toContain(
        `registerSurfaceSnapshotProvider(\n      "${surfaceId}"`,
      );
    }
  });

  it("no provider module is mapped for a surface that does not claim one", () => {
    for (const surfaceId of Object.keys(PROVIDER_MODULES)) {
      const surface = APP_SURFACES.find((s) => s.id === surfaceId);
      expect(surface, `unknown surface "${surfaceId}"`).toBeDefined();
      expect(
        (surface as { hasSnapshotProvider?: boolean }).hasSnapshotProvider,
        `${surfaceId} registers a provider but its manifest doesn't say so`,
      ).toBe(true);
    }
  });

  it("surfaces registering their own snapshotApp handler would shadow the app-level one", () => {
    // The bus dispatches newest-first and returns the first success, so a
    // second `snapshotApp` handler silently wins whenever its surface is
    // mounted — and a whole-app snapshot degrades to one screen.
    const source = readFileSync(
      join(repoRoot, PROVIDER_MODULES.playground),
      "utf-8",
    );
    expect(source).not.toContain('registerInspectorCommandHandler(\n      "snapshotApp"');
  });
});
