/**
 * Test fixture, hand-maintained: surfaceId → the repo-relative module that
 * calls `useSurfaceAgentBridge({ surfaceId: "<id>", ... })` for that surface.
 *
 * Shared by `agent-tool-coverage.test.ts` (every group surface must have a
 * bridge call in its OWN component — never a shared hook) and
 * `surface-snapshot-coverage.test.ts` (a bridge module is the second valid
 * convention for `hasSnapshotProvider`).
 *
 * A row is the component that OWNS the surface — the one whose mount is the
 * surface being on screen.
 */
export const BRIDGE_MODULES: Record<string, string> = {
  registry: "client/src/components/RegistryTab.tsx",
  // EvalsTab only — NEVER use-eval-handlers or anything CiEvalsTab mounts:
  // ci-evals stays agentTools kind "none".
  evals: "client/src/components/EvalsTab.tsx",
  // SwarmsTab owns its personas/journeys and the launch path; it does not
  // share state hooks with another surface, so the bridge lives here.
  swarms: "client/src/components/swarms/SwarmsTab.tsx",
  // HostsTab owns the host list + host mutations and the project servers a
  // set-servers call resolves against. It also wraps the /servers hub, but the
  // bridge always registers the literal "hosts" surface id — never a shared
  // state hook — so the group can't be mis-scoped.
  hosts: "client/src/components/HostsTab.tsx",
  // ComputerView owns the single computer's status + the lifecycle action hooks
  // (reserve/hibernate/reset/delete) and is the top component where the same
  // availability + daily-cap gates the buttons use are in scope. Not a shared
  // hook, so the "computer" group can't be mis-scoped.
  computer: "client/src/components/computer/ComputerView.tsx",
  // ChatboxesTab owns the previewed host's chatbox + the publish/generate/delete
  // flows (ensureChatboxForHost, the Generate-with-AI endpoints, deleteChatbox)
  // and the host list a publish/delete call resolves against. It honors the
  // Swarms-owned dead-end there. Not a shared hook (SwarmsTab is a separate
  // component), so the "chatboxes" group can't be mis-scoped.
  chatboxes: "client/src/components/ChatboxesTab.tsx",
  // ResourcesTab owns the resource/template lists and the readResourceApi path
  // its Read button uses; the group's ui_read_resource resolves against them.
  resources: "client/src/components/ResourcesTab.tsx",
  // PromptsTab owns the prompt list and the getPromptApi path its Run button
  // uses; the group's ui_get_prompt resolves against them.
  prompts: "client/src/components/PromptsTab.tsx",
  // ToolsTab is SNAPSHOT-ONLY: it declares agentTools kind "none" (execution is
  // already covered by the global ui_execute_tool, so a screen tool would
  // duplicate it) but calls useSurfaceAgentBridge with a snapshot ONLY. The row
  // exists so surface-snapshot-coverage can back its hasSnapshotProvider claim;
  // agent-tool-coverage permits a non-group row exactly when it's snapshot-only.
  tools: "client/src/components/ToolsTab.tsx",
};
