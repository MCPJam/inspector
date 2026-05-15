import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubStarButton } from "@/components/ui/github-star-button";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { GlobalHostBar } from "@/components/hosts/GlobalHostBar";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { GlobalHostBarProps } from "@/components/Header";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
  globalHostBarProps?: GlobalHostBarProps;
}

export function AuthUpperArea({
  activeServerSelectorProps,
  globalHostBarProps,
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
    </div>
  );

  return (
    <div className="ml-auto flex h-full flex-1 items-center gap-2 no-drag min-w-0">
      {globalHostBarProps ? (
        <div className="flex shrink-0 items-center pr-1">
          <GlobalHostBar {...globalHostBarProps} />
        </div>
      ) : null}
      {activeServerSelectorProps ? (
        <div className="flex-1 min-w-0 h-full pr-2">
          <ActiveServerSelector
            {...activeServerSelectorProps}
            className="h-full"
          />
        </div>
      ) : (
        <div className="flex-1 min-w-0 h-full pr-2" />
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="agents-cta-link hidden px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground min-[520px]:inline-flex"
        >
          <a
            href="https://docs.mcpjam.com/cli/overview"
            target="_blank"
            rel="noreferrer"
            aria-label="Open MCPJam CLI documentation"
            title="MCPJam CLI"
            onClick={() => {
              posthog.capture("agents_cta_clicked", {
                location: "header",
                platform: detectPlatform(),
                environment: detectEnvironment(),
              });
            }}
          >
            <span>MCPJam CLI</span>
          </a>
        </Button>
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
        <GitHubStarButton />
      </div>
    </div>
  );
}
