import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useLoginPage } from "@/hooks/use-log-in-page";
import { useEffect } from "react";

export default function LoginPage() {
  const { signUp, signIn } = useAuth();
  const posthog = usePostHog();
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const { hideLoginPage } = useLoginPage();

  useEffect(() => {
    posthog.capture("login_page_viewed", {
      location: "login_page",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  const logoSrc =
    themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png";

  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "login_page",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  const handleLogin = () => {
    posthog.capture("login_button_clicked", {
      location: "login_page",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signIn();
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
        <img src={logoSrc} alt="MCPJam" className="h-10 w-auto mb-2" />
        <div className="space-y-4 mb-12"></div>
        <div className="flex flex-col gap-3 w-full max-w-sm mb-6">
          <Button
            size="lg"
            variant="outline"
            onClick={handleLogin}
            className="px-16 py-6 text-lg w-full"
          >
            Log in
          </Button>
          <Button
            size="lg"
            onClick={handleSignUp}
            className="px-16 py-6 text-lg w-full"
          >
            Sign up
          </Button>
        </div>
        <button
          type="button"
          className="text-sm text-muted-foreground/80 underline hover:text-muted-foreground transition-colors cursor-pointer"
          onClick={() => {
            posthog.capture("continue_as_guest_button_clicked", {
              location: "login_page",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            hideLoginPage();
          }}
        >
          Or continue as guest
        </button>
      </div>
    </div>
  );
}
