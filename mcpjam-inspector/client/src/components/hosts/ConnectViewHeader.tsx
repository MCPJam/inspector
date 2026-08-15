import type { ReactNode } from "react";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { HostCanvasSelector } from "@/components/hosts/redesigned/HostCanvasSelector";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { HOSTED_MODE } from "@/lib/config";
import { track } from "@/lib/analytics";

export type ConnectViewValue =
  | "servers"
  | "host"
  | "compare"
  | "computer"
  | "skills";

interface ConnectViewHeaderProps {
  value: ConnectViewValue;
  previewedHostId: string | null;
  /**
   * Renders the client selector in the left column when set. Connect's
   * connection behavior differs per client, so the control belongs beside the
   * view it changes rather than in the global nav bar (PUR-21) — and the host
   * canvas already mounts the same selector in the same column, so switching
   * between Connect's views never moves it.
   *
   * Omitted where there is no project to read clients from (local mode with
   * no cloud project), which leaves the column empty exactly as before.
   */
  projectId?: string | null;
  onChange: (next: ConnectViewValue) => void;
  /**
   * Optional content placed in the third grid column (typically the
   * Servers-view "add server" slot). Default is an empty placeholder so the
   * centered selector stays centered.
   */
  rightSlot?: ReactNode;
  testId?: string;
}

export function ConnectViewHeader({
  value,
  previewedHostId,
  projectId,
  onChange,
  rightSlot,
  testId = "hosts-tab-header-chrome",
}: ConnectViewHeaderProps) {
  // The Computer tab only appears for users the `computers-enabled` flag is
  // rolled out to (also keeps it hidden pre-launch).
  const computersEnabled = useComputersEnabled();
  // Skills is gated by `skills-enabled` in HOSTED mode only — local-mode
  // filesystem skills never read the flag (see `useSkillsEnabled`), so the tab
  // stays visible in the local app / Electron exactly as it was as a sidebar
  // item. Hook is called unconditionally; only its use is mode-dependent.
  const skillsEnabled = useSkillsEnabled();
  const showSkillsTab = !HOSTED_MODE || skillsEnabled;

  const handleChange = (next: ConnectViewValue) => {
    // Servers view switching had no tracking of its own; Skills moving here
    // from the sidebar would otherwise drop the `sidebar_nav_clicked` signal
    // for skills entries. One wrapper covers every route that renders this
    // header.
    try {
      track("connect_view_selected", { from: value, to: next });
    } catch {
      // swallow — a posthog throw must never block navigation
    }
    onChange(next);
  };

  return (
    <div
      className="@container relative shrink-0 border-b border-border/40 px-4 py-2.5 md:px-8"
      data-testid={testId}
    >
      {/* The layout switch is gated on the header's own width via `@container`
          (not the viewport) so it stacks correctly when the sidebar is open
          and the container — not the window — is narrow. Below the container
          breakpoint the selector and right slot stack into one column. */}
      <div className="flex flex-col items-stretch gap-2 @2xl:grid @2xl:grid-cols-[1fr_auto_1fr] @2xl:items-center @2xl:gap-3">
        {/* Same column, same component, same position as the host canvas
            mounts it (see HostBuilderViewRedesigned) — so the client selector
            never moves as the user switches between Connect's views.
            Gated on `shouldQueryProjectId`, not bare truthiness: a
            local/placeholder or UUID project id mid-transition is truthy but
            `useHostList` skips it, which would otherwise leave this selector
            on a permanent loading skeleton instead of the empty column it
            renders while there's genuinely no project to read clients from. */}
        {projectId && shouldQueryProjectId(projectId) ? (
          <div className="flex min-w-0 justify-center @2xl:justify-start">
            <HostCanvasSelector
              projectId={projectId}
              activeHostId={previewedHostId}
              // These views don't render a client the way the canvas does, so
              // switching must leave the user on Servers/Computer/Skills.
              syncCanvasRoute={false}
            />
          </div>
        ) : (
          <div className="hidden @2xl:block" aria-hidden="true" />
        )}
        <div className="flex min-w-0 justify-center">
          <ViewModeSelector
            value={value}
            ariaLabel="Connect view"
            onChange={handleChange}
            options={[
              { value: "servers", label: "Servers" },
              {
                value: "host",
                label: "Client",
                disabled: !previewedHostId,
              },
              // "Compare" now lives as a sub-tab inside the Host section
              // (see HostSectionTabs) rather than a peer primary tab.
              ...(computersEnabled
                ? ([{ value: "computer", label: "Computer" }] as const)
                : []),
              // Skills is execution-context config like the tabs above it, so
              // it lives here rather than in the sidebar. Hidden in hosted mode
              // until `skills-enabled` is rolled out; always shown locally.
              ...(showSkillsTab
                ? ([{ value: "skills", label: "Skills" }] as const)
                : []),
            ]}
          />
        </div>
        {rightSlot ?? <div className="hidden @2xl:block" aria-hidden="true" />}
      </div>
    </div>
  );
}
