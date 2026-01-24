import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
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
import { CircleUser, LogOut, RefreshCw, Settings, User } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { useProfilePicture } from "@/hooks/useProfilePicture";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
}

export function AuthUpperArea({
  activeServerSelectorProps,
}: AuthUpperAreaProps) {
  const { isLoading } = useConvexAuth();
  const { user, signIn, signOut, signUp } = useAuth();
  const posthog = usePostHog();
  const { profilePictureUrl } = useProfilePicture();
  const convexUser = useQuery("users:getCurrentUser" as any);

  const communityLinks = (
    <div className="flex items-center gap-1">
      <Button asChild size="icon" variant="ghost">
        <a
          href="https://discord.gg/JEnDtz8X6z"
          target="_blank"
          rel="noreferrer"
          aria-label="Join the Discord community"
          title="Join the Discord community"
        >
          <DiscordIcon className="h-10 w-10" />
          <span className="sr-only">Discord</span>
        </a>
      </Button>
      <Button asChild size="icon" variant="ghost">
        <a
          href="https://github.com/MCPJam/inspector"
          target="_blank"
          rel="noreferrer"
          aria-label="Visit the GitHub repository"
          title="Visit the GitHub repository"
        >
          <GitHubIcon className="h-10 w-10" />
          <span className="sr-only">GitHub</span>
        </a>
      </Button>
    </div>
  );

  // Prefer convexUser name (can be edited) over WorkOS user name
  const workOsName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ")
    : "";
  const displayName = convexUser?.name || workOsName || "User";
  const email = user?.email ?? "";
  const initials = getInitials(displayName);

  const handleSignOut = () => {
    const isElectron = (window as any).isElectron;
    const returnTo =
      isElectron && import.meta.env.DEV
        ? "http://localhost:8080/callback"
        : window.location.origin;
    signOut({ returnTo });
  };

  const avatarUrl = profilePictureUrl;

  const dropdown = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex size-10 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-sm outline-none transition hover:ring-2 hover:ring-ring/20 focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar className="size-9 cursor-pointer">
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
            <Avatar className="size-10 cursor-pointer">
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
        <DropdownMenuItem
          onClick={() => (window.location.hash = "profile")}
          className="cursor-pointer"
        >
          <User className="size-4" />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => (window.location.hash = "settings")}
          className="cursor-pointer"
        >
          <Settings className="size-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={handleSignOut}
          className="cursor-pointer"
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderAuthControls = () => {
    if (!user) {
      return (
        <div className="flex items-center gap-2">
          {communityLinks}
          {isLoading ? (
            <Button variant="outline" size="sm" disabled>
              <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  posthog.capture("login_button_clicked", {
                    location: "auth_upper_area",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  signIn();
                }}
              >
                Sign in
              </Button>
              <Button
                onClick={() => {
                  posthog.capture("sign_up_button_clicked", {
                    location: "auth_upper_area",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  signUp();
                }}
              >
                Create account
              </Button>
            </>
          )}
        </div>
      );
    }

    if (isLoading) {
      return (
        <div className="flex items-center gap-2">
          {communityLinks}
          <Button variant="outline" size="sm" disabled>
            <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
          </Button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2">
        {communityLinks}
        {dropdown}
      </div>
    );
  };

  return (
    <div className="ml-auto flex h-full flex-1 items-center gap-2 no-drag min-w-0">
      {activeServerSelectorProps && (
        <div className="flex-1 min-w-0 h-full pr-2">
          <ActiveServerSelector
            {...activeServerSelectorProps}
            className="h-full"
          />
        </div>
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {renderAuthControls()}
      </div>
    </div>
  );
}
