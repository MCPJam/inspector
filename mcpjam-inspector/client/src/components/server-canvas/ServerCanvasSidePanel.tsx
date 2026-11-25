import type { FormEvent, ReactNode } from "react";
import { FocusTabBar } from "@/components/canvas-kit/FocusTabBar";
import type { ServerDetailController } from "@/components/connection/hooks/use-server-detail-controller";
import {
  ServerAuthTabBody,
  ServerClientsTabBody,
  ServerConfigSaveButton,
  ServerConfigTabBody,
  ServerHistoryTabBody,
  ServerOverviewTabBody,
  ServerSettingsTabBody,
  ServerToolsTabBody,
} from "@/components/connection/ServerDetailTabBodies";

const bodyClass = "px-5 py-4";

/** Nothing to dismiss: a page stays put when the Clients report navigates. */
function stayOnPage() {}

/**
 * The right half of the server page: the modal's tabs through the focus tab
 * bar, with the selected feature's detail above the active tab. Config stays
 * mounted while hidden, as in the modal, so unsaved edits survive a tab
 * switch; Settings stays mounted once visited.
 */
export function ServerCanvasSidePanel({
  controller,
  detail,
  projectXaaDefaultIdentity,
  evaluatedCapabilities,
}: {
  controller: ServerDetailController;
  /** The feature detail, shown above the active tab while one is selected. */
  detail: ReactNode;
  projectXaaDefaultIdentity: { subject: string; email: string } | null;
  /** Overview's capabilities; undefined leaves Overview its own reading. */
  evaluatedCapabilities: readonly string[] | undefined;
}) {
  const { tabs } = controller;
  // A deep link to a tab this server does not show lands on Config.
  const shown = tabs.visible.some((tab) => tab.id === tabs.active)
    ? tabs.active
    : "configuration";
  const label = tabs.visible.find((tab) => tab.id === shown);
  // The controller saves only from its active tab; when Config is shown in
  // place of a tab this server lacks, save from here instead.
  const submit =
    shown === tabs.active
      ? controller.form.submit
      : (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!controller.form.saveBlocked) void controller.form.save();
        };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background">
      <div className="shrink-0 border-b border-border px-3">
        <FocusTabBar tab={shown} onTabChange={tabs.select} tabs={tabs.visible} />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="server-canvas-panel"
      >
        {detail}
        <div role="tabpanel" aria-label={label?.ariaLabel ?? label?.label}>
          <form
            onSubmit={submit}
            hidden={shown !== "configuration"}
            className={bodyClass}
          >
            <ServerConfigTabBody
              controller={controller}
              projectXaaDefaultIdentity={projectXaaDefaultIdentity}
            />
            <div className="mt-4 flex justify-end border-t border-border pt-4">
              <ServerConfigSaveButton controller={controller} />
            </div>
          </form>
          {controller.settings.showBody ? (
            <div hidden={shown !== "settings"}>
              <ServerSettingsTabBody controller={controller} />
            </div>
          ) : null}
          {shown === "overview" ? (
            <div className={bodyClass}>
              <ServerOverviewTabBody
                controller={controller}
                evaluatedCapabilities={evaluatedCapabilities}
              />
            </div>
          ) : null}
          {shown === "authorization" ? (
            <div className={`${bodyClass} space-y-4`}>
              <ServerAuthTabBody controller={controller} />
            </div>
          ) : null}
          {shown === "tools-metadata" ? (
            <div className={bodyClass}>
              <ServerToolsTabBody controller={controller} />
            </div>
          ) : null}
          {shown === "compatibility" ? (
            <div className={bodyClass}>
              <ServerClientsTabBody controller={controller} onClose={stayOnPage} />
            </div>
          ) : null}
          {shown === "history" ? (
            <div className={bodyClass}>
              <ServerHistoryTabBody controller={controller} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
