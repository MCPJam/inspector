import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";

export function AuthButton() {
  // Use Convex only for loading signal; rely on WorkOS user presence for UI state
  const { isLoading } = useConvexAuth();
  const { user, signIn, signOut } = useAuth();

  if (isLoading) {
    return (
      <Button variant="outline" size="sm" disabled>
        Loading...
      </Button>
    );
  }

  if (!user) {
    return (
      <Button variant="outline" size="sm" onClick={() => signIn()}>
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground max-w-[160px] truncate">
        {user?.email || user?.id}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const isElectron = (window as any).isElectron;
          // Normalize returnTo for WorkOS: prefer 127.0.0.1 when running on localhost
          const origin = window.location.origin;
          const normalizedOrigin = origin.includes("://localhost")
            ? origin.replace("://localhost", "://127.0.0.1")
            : origin;
          const devElectronReturn = "http://localhost:8080/callback";
          const returnTo =
            isElectron && import.meta.env.DEV
              ? devElectronReturn
              : normalizedOrigin;
          signOut({ returnTo });
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
