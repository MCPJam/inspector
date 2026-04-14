import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@/components/ui/button";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
}

export function AuthUpperArea({
  activeServerSelectorProps,
}: AuthUpperAreaProps) {
  const { user, signIn, signUp } = useAuth();
  const { isLoading } = useConvexAuth();
  const posthog = usePostHog();

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
        {communityLinks}
        <NotificationBell />
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
