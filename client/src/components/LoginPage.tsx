import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { useLoginPage } from "@/hooks/use-log-in-page";

export default function LoginPage() {
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const { hideLoginPage } = useLoginPage();

  const logoSrc =
    themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png";

  const handleSignUp = () => {
    posthog.capture("create_account", {
      location: "login_page",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
        <button
          type="button"
          onClick={hideLoginPage}
          aria-label="Close login"
          className="absolute right-4 top-4 rounded-full p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
        <img src={logoSrc} alt="MCPJam" className="h-12 w-auto mb-8" />
        <div className="space-y-4 mb-12"></div>
        <Button
          size="lg"
          onClick={handleSignUp}
          className="px-16 py-6 text-lg mb-6"
        >
          Sign up
        </Button>
        <button
          type="button"
          onClick={hideLoginPage}
          className="text-sm text-muted-foreground/80 underline hover:text-muted-foreground transition-colors cursor-pointer"
        >
          Or continue as guest
        </button>
      </div>
    </div>
  );
}
