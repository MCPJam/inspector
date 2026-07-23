import type { ReactNode } from "react";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";

export type ConnectViewValue = "servers" | "host" | "compare" | "computer";

interface ConnectViewHeaderProps {
  value: ConnectViewValue;
  previewedHostId: string | null;
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
  onChange,
  rightSlot,
  testId = "hosts-tab-header-chrome",
}: ConnectViewHeaderProps) {
  // The Computer tab only appears for users the `computers-enabled` flag is
  // rolled out to (also keeps it hidden pre-launch).
  const computersEnabled = useComputersEnabled();
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
        <div className="hidden @2xl:block" aria-hidden="true" />
        <div className="flex min-w-0 justify-center">
          <ViewModeSelector
            value={value}
            ariaLabel="Connect view"
            onChange={onChange}
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
            ]}
          />
        </div>
        {rightSlot ?? <div className="hidden @2xl:block" aria-hidden="true" />}
      </div>
    </div>
  );
}
