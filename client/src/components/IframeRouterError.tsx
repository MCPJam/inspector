export function IframeRouterError() {
  return (
    <div className="flex items-center justify-center h-screen p-5 font-sans bg-neutral-50 text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
      <div className="max-w-[400px] leading-relaxed text-center">
        <p className="mb-3">
          <strong>Router issue:</strong> Your app uses{" "}
          <code className="bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 rounded text-[0.9em]">
            BrowserRouter
          </code>
          , which isn't supported in iframes.
        </p>
        <p className="text-sm opacity-70">
          Switch to{" "}
          <code className="bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 rounded text-[0.9em]">
            MemoryRouter
          </code>{" "}
          or{" "}
          <code className="bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 rounded text-[0.9em]">
            HashRouter
          </code>{" "}
          instead, then re-run your tool.
        </p>
      </div>
    </div>
  );
}
