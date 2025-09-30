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
import { usePostHog } from "posthog-js/react";
export function AuthUpperArea() {
  const { isLoading } = useConvexAuth();
  const { user, signIn, signOut, signUp } = useAuth();
  const posthog = usePostHog();
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
          onClick={() => {
            posthog.capture("sign_in", { location: "auth_upper_area" });
            signIn();
          }}
        >
          Sign in
        </Button>
        <Button
          onClick={() => {
            posthog.capture("create_account", { location: "auth_upper_area" });
            signUp();
          }}
          style={{ backgroundColor: "#E55A3A" }}
        >
          Create account
        </Button>
      </div>
    );
  }

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const email = user.email;
  const initials = getInitials(displayName);

  const handleSignOut = () => {
    const isElectron = (window as any).isElectron;
    const origin = window.location.origin;
    const normalizedOrigin = origin.includes("://localhost")
      ? origin.replace("://localhost", "://127.0.0.1")
      : origin;
    const returnTo =
      isElectron && import.meta.env.DEV
        ? "http://localhost:8080/callback"
        : normalizedOrigin;
    signOut({ returnTo });
  };

  const avatarUrl = user.profilePictureUrl || undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex size-10 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-sm outline-none transition hover:ring-2 hover:ring-ring/20 focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar className="size-9">
            <AvatarImage src={avatarUrl} alt={displayName} />
            <AvatarFallback className="bg-muted text-muted-foreground text-sm font-medium">
              {initials !== "?" ? initials : <CircleUser className="size-4" />}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
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
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-none truncate">
                {displayName}
              </p>
              <p className="text-xs text-muted-foreground truncate">{email}</p>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => (window.location.hash = "settings")}>
          <Settings className="size-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
