import { useEffect } from "react";

interface OAuthDesktopReturnNoticeProps {
  returnToElectronUrl: string;
}

const attemptedDesktopReturnUrls = new Set<string>();

export function redirectBrowserCallbackToElectron(
  returnToElectronUrl: string,
  navigate: Pick<Location, "replace"> = window.location,
) {
  if (window.isElectron) {
    return;
  }

  navigate.replace(returnToElectronUrl);
}

export const desktopReturnRuntime = {
  redirect: redirectBrowserCallbackToElectron,
};

export function resetDesktopReturnAttemptsForTests() {
  attemptedDesktopReturnUrls.clear();
}

export default function OAuthDesktopReturnNotice({
  returnToElectronUrl,
}: OAuthDesktopReturnNoticeProps) {
  useEffect(() => {
    // React StrictMode replays effects in development, so guard the custom
    // protocol handoff to avoid showing duplicate "Open Electron?" prompts.
    if (attemptedDesktopReturnUrls.has(returnToElectronUrl)) {
      return;
    }

    attemptedDesktopReturnUrls.add(returnToElectronUrl);
    desktopReturnRuntime.redirect(returnToElectronUrl);
  }, [returnToElectronUrl]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-md border bg-secondary p-4">
        <p className="text-sm font-medium">Continue in MCPJam Desktop</p>
        <p className="mt-2 text-xs text-muted-foreground">
          MCPJam Desktop should open automatically. If you are back in the
          browser, please close this page and continue in MCPJam Desktop.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          If nothing happened,{" "}
          <a className="underline" href={returnToElectronUrl}>
            click here
          </a>
          .
        </p>
      </div>
    </div>
  );
}
