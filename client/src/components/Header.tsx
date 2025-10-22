import { AuthUpperArea } from "./auth/auth-upper-area";
import { SidebarTrigger } from "./ui/sidebar";
import { useHeaderIpc } from "./ipc/use-header-ipc";

export const Header = () => {
  const { activeIpc, dismissActiveIpc } = useHeaderIpc();

  return (
    <header className="flex shrink-0 flex-col border-b transition-[width,height] ease-linear">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-6 drag">
        <div className="flex items-center gap-1 lg:gap-2 no-drag">
          <SidebarTrigger className="-ml-1" />
        </div>
        <div className="ml-auto flex items-center gap-2 no-drag">
          <AuthUpperArea />
        </div>
      </div>
      {activeIpc && activeIpc.render({ dismiss: dismissActiveIpc })}
    </header>
  );
};
