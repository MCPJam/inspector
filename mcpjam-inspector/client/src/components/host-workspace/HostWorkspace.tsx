import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./host-workspace.css";

/**
 * Inline App layout for surfaces without the Playground's right rail: compare
 * lanes and unattended runs. The App sits beside the conversation; in a
 * narrow container it takes the lane over and its own header offers "Back to
 * chat". The single-chat Playground draws Apps in its right rail instead.
 *
 * Client presentation only. Its caller owns data, execution and lifetimes.
 */
export function HostWorkspace({
  children,
  appPanel,
  appOpen = false,
}: {
  children: ReactNode;
  appPanel?: ReactNode;
  appOpen?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(768);
  useLayoutEffect(() => {
    if (!appPanel || !root.current) return;
    const element = root.current;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(appPanel)]);
  const takeover = width < 768;
  return (
    <div
      ref={root}
      className="relative flex flex-col flex-1 min-h-0"
      data-host-workspace-split={(appOpen && !takeover) || undefined}
      data-host-workspace-takeover={(appOpen && takeover) || undefined}
      style={
        !appOpen || takeover ? undefined : { paddingInlineEnd: "50%" }
      }
    >
      {children}
      {appPanel && (
        <div
          data-host-workspace-app-panel
          hidden={!appOpen}
          className="absolute inset-y-0 end-0 border-s border-border"
          style={{ width: takeover ? "100%" : "50%" }}
        >
          {appPanel}
        </div>
      )}
    </div>
  );
}
