import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { CircleUser, LogOut, RefreshCw, Settings } from "lucide-react";

export function AuthUpperArea() {
  const { isLoading } = useConvexAuth();
  const { user, signIn, signOut } = useAuth();

  if (isLoading) {
    return (
      <Button variant="outline" size="sm" disabled>
        <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
      </Button>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => signIn()}
          className="cursor-pointer"
        >
          Sign in
        </Button>
        <Button
          onClick={() => signIn()}
          style={{ backgroundColor: "#E55A3A" }}
          className="hover:opacity-90 cursor-pointer"
        >
          Create account
        </Button>
      </div>
    );
  }

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    user.id;
  const email = user.email || user.id;
  const avatarUrl = user.profilePictureUrl || undefined;
  const initials = getInitials(displayName);

  const handleSignOut = () => {
    const isElectron = (window as any).isElectron;
    // Normalize returnTo for WorkOS: prefer 127.0.0.1 when running on localhost
    const origin = window.location.origin;
    const normalizedOrigin = origin.includes("://localhost")
      ? origin.replace("://localhost", "://127.0.0.1")
      : origin;
    const devElectronReturn = "http://localhost:8080/callback";
    const returnTo =
      isElectron && import.meta.env.DEV ? devElectronReturn : normalizedOrigin;
    signOut({ returnTo });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className="border-border/60 focus-visible:ring-ring bg-background/80 hover:ring-ring/20 flex size-10 items-center justify-center rounded-full border shadow-sm outline-none transition hover:ring-2 focus-visible:ring-2 cursor-pointer"
        >
          <Avatar className="size-9">
            <AvatarImage src={avatarUrl} alt={displayName} />
            <AvatarFallback className="bg-muted text-muted-foreground text-sm font-medium">
              {initials !== "?" ? initials : <CircleUser className="size-4" />}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="end" sideOffset={8}>
        <DropdownMenuLabel className="pb-3">
          <div className="flex items-center gap-3">
            <Avatar className="size-10">
              <AvatarImage src={avatarUrl} alt={displayName} />
              <AvatarFallback className="bg-muted text-muted-foreground text-base font-semibold">
                {initials !== "?" ? (
                  initials
                ) : (
                  <CircleUser className="size-5" />
                )}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-0.5">
              <p className="text-sm font-medium leading-none">{displayName}</p>
              <p className="text-xs text-muted-foreground truncate">{email}</p>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            window.location.hash = "settings";
          }}
          className="cursor-pointer"
        >
          <Settings className="size-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            handleSignOut();
          }}
          className="cursor-pointer"
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
