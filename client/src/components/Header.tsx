import { AuthUpperArea } from "./auth/auth-upper-area";
import { SidebarTrigger } from "./ui/sidebar";

export const Header = () => {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear drag">
      <div className="flex w-full items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-1 lg:gap-2">
          <SidebarTrigger className="-ml-1" />
        </div>
        <div className="flex items-center gap-2">
          <AuthUpperArea />
        </div>
      </div>
    </header>
  );
};
