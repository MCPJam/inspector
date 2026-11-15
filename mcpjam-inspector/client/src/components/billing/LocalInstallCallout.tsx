import { DESKTOP_APP_DOWNLOAD_URL } from "@/lib/hosted-connect-precheck";

export function LocalInstallCallout() {
  if (import.meta.env.VITE_MCPJAM_HOSTED_MODE !== "true") return null;
  return (
    <section
      className="space-y-2 rounded-lg border border-border p-4"
      aria-label="Use Inspector locally"
    >
      <h3 className="text-sm font-semibold">Use Inspector on your computer</h3>
      <p className="text-sm">
        Connect local servers with the desktop app or run{" "}
        <code>npx @mcpjam/inspector@latest</code> in your terminal.
      </p>
      <a
        className="text-sm underline"
        href={DESKTOP_APP_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Download the desktop app
      </a>
    </section>
  );
}
