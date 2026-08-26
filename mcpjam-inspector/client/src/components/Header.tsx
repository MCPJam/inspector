import { AuthUpperArea } from "./auth/auth-upper-area";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";
import { useHeaderIpc } from "./ipc/use-header-ipc";
import { ActiveServerSelectorProps } from "./ActiveServerSelector";

export interface GlobalHostBarProps {
  projectId: string;
  onEditHost: (hostId: string) => void;
  // Provided only while the host canvas is open. Re-targets it when the
  // dropdown's active host changes, so picking a host updates the diagram
  // instead of only the preview pointer used by chat/evals.
  onCanvasReplaceHost?: (hostId: string) => void;
}

interface HeaderProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
  globalHostBarProps?: GlobalHostBarProps;
}

export const Header = ({
  activeServerSelectorProps,
  globalHostBarProps,
}: HeaderProps) => {
  const { activeIpc, dismissActiveIpc } = useHeaderIpc();
  const { isMobile } = useSidebar();

  return (
    // Production Redesign chrome (BB-127): the top bar is part of the linen
    // frame, so it stays transparent (inheriting the inset's `bg-sidebar`) and
    // borderless — the panel's rounded top edge is the only divider.
    <header className="flex shrink-0 flex-col transition-[width,height] ease-linear">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-6 drag">
        {isMobile ? (
          <div className="flex items-center gap-1 lg:gap-2 no-drag">
            <SidebarTrigger className="-ml-1" aria-label="Open menu" />
          </div>
        ) : null}
        <AuthUpperArea
          activeServerSelectorProps={activeServerSelectorProps}
          globalHostBarProps={globalHostBarProps}
        />
      </div>
      {activeIpc && activeIpc.render({ dismiss: dismissActiveIpc })}
    </header>
  );
};
