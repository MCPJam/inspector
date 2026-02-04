import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
}

export function AuthUpperArea({
  activeServerSelectorProps,
}: AuthUpperAreaProps) {
  const { user, signIn, signUp } = useAuth();
  const { isLoading } = useConvexAuth();
  const posthog = usePostHog();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeToggle = () => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  };

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
        <Button
          size="icon"
          variant="ghost"
          onClick={handleThemeToggle}
          aria-label={
            themeMode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
          title={
            themeMode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
        >
          {themeMode === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </Button>
        <NotificationBell />
        {communityLinks}
        {!user && !isLoading && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                posthog.capture("login_button_clicked", {
                  location: "header",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                signIn();
              }}
            >
              Sign in
            </Button>
            <Button
              size="sm"
              onClick={() => {
                posthog.capture("sign_up_button_clicked", {
                  location: "header",
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
    </div>
  );
}
