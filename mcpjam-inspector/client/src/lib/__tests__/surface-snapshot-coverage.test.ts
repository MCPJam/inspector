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
import { BRIDGE_MODULES } from "./agent-bridge-modules";

const repoRoot = join(__dirname, "../../../..");
const HOOK_MODULE =
  "client/src/components/ui-playground/hooks/use-playground-state.ts";
/**
 * surfaceId → the ROUTE module that opts this instance in by passing
 * `snapshotSurfaceId`. Registration is opt-in per caller (the hook backs both
 * the Playground screen and the Evals Record panel's embedded chat), so the
 * screen that claims the id is what matters, not the hook.
 *
 * A SECOND convention exists since the surface-tools foundation: a surface
 * whose component calls `useSurfaceAgentBridge({ surfaceId, snapshot })` is
 * covered by its `BRIDGE_MODULES` row instead (agent-tool-coverage.test.ts
 * checks the bridge call itself; here we only accept the row as the claim's
 * backing).
 */
const OPT_IN_MODULES: Record<string, string> = {
  playground: "client/src/components/playground/PlaygroundTab.tsx",
};

describe("surfaces that claim a snapshot provider register one", () => {
  const flagged = listAppSurfaces().filter((s) => s.hasSnapshotProvider);

  it("every flagged surface has a known opt-in or bridge module", () => {
    for (const surface of flagged) {
      expect(
        OPT_IN_MODULES[surface.id] ?? BRIDGE_MODULES[surface.id],
        `${surface.id} claims hasSnapshotProvider but neither OPT_IN_MODULES nor BRIDGE_MODULES maps it`,
      ).toBeDefined();
    }
  });

  it("every bridge module passes its own literal surface id", () => {
    for (const [surfaceId, modulePath] of Object.entries(BRIDGE_MODULES)) {
      const source = readFileSync(join(repoRoot, modulePath), "utf-8");
      expect(source, `${modulePath} must bridge as "${surfaceId}"`).toContain(
        `surfaceId: "${surfaceId}"`,
      );
    }
  });

  it("the hook registers under the opt-in id, never a hard-coded one", () => {
    // The bug this guards against: registering unconditionally under a
    // literal "playground" would let the Evals panel's embedded chat shadow
    // the real screen.
    const source = readFileSync(join(repoRoot, HOOK_MODULE), "utf-8");
    expect(source).toContain("registerSurfaceSnapshotProvider(snapshotSurfaceId");
    expect(source).not.toContain(
      'registerSurfaceSnapshotProvider(\n      "playground"',
    );
  });

  it("every opt-in module passes its surface id to the hook", () => {
    for (const [surfaceId, modulePath] of Object.entries(OPT_IN_MODULES)) {
      const source = readFileSync(join(repoRoot, modulePath), "utf-8");
      expect(source, `${modulePath} must opt in as "${surfaceId}"`).toContain(
        `snapshotSurfaceId: "${surfaceId}"`,
      );
    }
  });

  it("no opt-in module is mapped for a surface that does not claim one", () => {
    for (const surfaceId of [
      ...Object.keys(OPT_IN_MODULES),
      ...Object.keys(BRIDGE_MODULES),
    ]) {
      const surface = APP_SURFACES.find((s) => s.id === surfaceId);
      expect(surface, `unknown surface "${surfaceId}"`).toBeDefined();
      expect(
        (surface as { hasSnapshotProvider?: boolean }).hasSnapshotProvider,
        `${surfaceId} registers a provider but its manifest doesn't say so`,
      ).toBe(true);
    }
  });

  it("the hook does not register its own snapshotApp handler (would shadow App.tsx's)", () => {
    // The bus dispatches newest-first and returns the first success, so a
    // second `snapshotApp` handler silently wins whenever its surface is
    // mounted — and a whole-app snapshot degrades to one screen.
    const source = readFileSync(join(repoRoot, HOOK_MODULE), "utf-8");
    expect(source).not.toContain(
      'registerInspectorCommandHandler(\n      "snapshotApp"',
    );
  });
});
