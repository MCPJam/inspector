/**
 * The ONE hook a surface calls to plug into the agent: its tool group, its
 * inspector-command handlers, and its snapshot provider, all tied to the
 * surface's mount lifecycle.
 *
 * ## Contract
 *
 * - **Mount/unmount lifecycle.** Everything registers in one layout effect
 *   keyed ONLY by `surfaceId` and unregisters on cleanup: unmount (or a
 *   `surfaceId` change) aborts the group's registrations and disposes the
 *   handlers and the snapshot provider. StrictMode's setup/cleanup/setup and
 *   HMR remounts are safe — cleanup always runs before re-setup, so the
 *   registry's live-collision guard never fires.
 *
 * - **Stable refs.** `handlers` and `snapshot` may be fresh closures every
 *   render — they are kept in refs assigned each render, and the effect
 *   registers STABLE wrappers exactly once. A handler wrapper looks up
 *   `handlersRef.current[type]` at dispatch time; the snapshot wrapper calls
 *   `snapshotRef.current?.()`. So rerenders never re-register anything, and
 *   dispatch always sees the latest closure. Two things ARE fixed at the
 *   effect run: the SET of handler types (its keys must be stable across
 *   renders) and whether a `snapshot` was provided at mount. If a handler
 *   entry vanishes from the record after mount, its wrapper throws the
 *   `unsupported_in_mode` `InspectorCommandClientError`, which the command
 *   bus treats as "try the next handler / report unhandled" — the same
 *   fall-through semantics as an unregistered handler.
 *
 * - **Group tools are optional.** `SURFACE_TOOL_GROUPS[surfaceId]` is
 *   registered mount-scoped (`scope: "surface"`) when it exists and skipped
 *   silently when it doesn't — snapshot-only surfaces use this same bridge
 *   with just `snapshot` (and flip `hasSnapshotProvider` in the manifest).
 *
 * - **NEVER call this from a shared hook.** Call it from the surface's own
 *   component, exactly once per surface. The hazard is real: EvalsTab and
 *   CiEvalsTab share their state hooks (`use-eval-handlers` and friends), so
 *   a bridge call inside a shared hook would register the evals group and
 *   handlers under the WRONG surface id on /ci-evals — or twice at once when
 *   both screens' machinery is alive. Same reason `use-playground-state`
 *   takes an explicit opt-in `snapshotSurfaceId` instead of hardcoding one.
 */

import { useLayoutEffect, useRef } from "react";
import {
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
  type InspectorCommandHandler,
} from "@/lib/inspector-command-handlers";
import type {
  InspectorCommand,
  InspectorCommandType,
} from "@/shared/inspector-command.js";
import type { AppSurfaceId } from "@/shared/app-surfaces";
import { useUiToolsRegistry } from "./ui-tools-registry";
import { registerSurfaceSnapshotProvider } from "./surface-snapshot-registry";
import { SURFACE_TOOL_GROUPS } from "./groups";

export interface SurfaceAgentBridgeOptions {
  /** The surface's literal id — the effect's only key. */
  surfaceId: AppSurfaceId;
  /**
   * Command handlers this surface owns while mounted. The values may be new
   * closures every render; the KEY SET must be stable for the mount.
   */
  handlers?: Partial<Record<InspectorCommandType, InspectorCommandHandler>>;
  /**
   * Snapshot provider for `ui_snapshot_app`. Read-only by contract — it
   * must observe state, never change it. Registering it is what makes the
   * manifest's `hasSnapshotProvider: true` honest.
   */
  snapshot?: () => unknown;
}

export function useSurfaceAgentBridge(
  options: SurfaceAgentBridgeOptions,
): void {
  const { surfaceId } = options;
  const handlersRef = useRef(options.handlers);
  const snapshotRef = useRef(options.snapshot);
  // Sync the latest closures in a layout effect (every commit, no deps) rather
  // than during render, so a discarded concurrent render can never make
  // dispatch read props that never committed. Runs before the registration
  // effect below, so the stable wrappers always see current values.
  useLayoutEffect(() => {
    handlersRef.current = options.handlers;
    snapshotRef.current = options.snapshot;
  });

  // Layout effect, matching the surfaces' own mount effects: the group's
  // tools must be live before the App navigate handler's readiness wait
  // (`waitForUiToolNames`) samples the registry after the route commits.
  useLayoutEffect(() => {
    const controller = new AbortController();
    const disposers: Array<() => void> = [];

    // 1. Surface tool group, when one exists. Mount-scoped: `scope:
    // "surface"` keeps these behind the global catalog in the chat-body
    // snapshot's 64-entry cap.
    const group = SURFACE_TOOL_GROUPS[surfaceId];
    if (group) {
      const registerUiTool = useUiToolsRegistry.getState().registerUiTool;
      for (const def of group.buildTools()) {
        registerUiTool(def, { signal: controller.signal, scope: "surface" });
      }
    }

    // 2. Command handlers: one stable wrapper per type present at mount.
    const handlerTypes = Object.keys(
      handlersRef.current ?? {},
    ) as InspectorCommandType[];
    for (const type of handlerTypes) {
      const wrapper: InspectorCommandHandler = (command: InspectorCommand) => {
        const handler = handlersRef.current?.[type];
        if (!handler) {
          // The entry vanished after mount. Throw the bus's fall-through
          // error so dispatch consults older handlers (or reports
          // unhandled) — identical to the tool never registering here.
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            `Surface "${surfaceId}" no longer handles "${type}".`,
          );
        }
        return handler(command);
      };
      disposers.push(registerInspectorCommandHandler(type, wrapper));
    }

    // 3. Snapshot provider — only when the surface provided one at mount.
    if (snapshotRef.current) {
      disposers.push(
        registerSurfaceSnapshotProvider(surfaceId, () =>
          snapshotRef.current?.(),
        ),
      );
    }

    return () => {
      controller.abort();
      for (const dispose of disposers) dispose();
    };
  }, [surfaceId]);
}
