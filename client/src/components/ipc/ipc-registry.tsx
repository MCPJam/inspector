import type { ReactNode } from "react";
import { Button } from "../ui/button";

export type HeaderIpc = {
  id: string;
  render: (context: { dismiss: () => void }) => ReactNode;
};

// Append new IPC entries here. Use a new unique `id` so previously dismissed
// banners will not automatically reappear.
export const headerIpcs: HeaderIpc[] = [
  {
    id: "ipc-2024-beta-feedback",
    render: ({ dismiss }) => (
      <div className="no-drag bg-indigo-600 px-4 py-2 text-white lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="leading-snug">
            Inspector Cloud is in active development - share feedback so we can
            improve MDC tooling!
          </p>
          <div className="flex items-center gap-2">
            <Button
              asChild
              size="sm"
              variant="secondary"
              className="bg-white text-indigo-700 hover:bg-white/90"
            >
              <a
                href="https://example.com/feedback"
                target="_blank"
                rel="noopener noreferrer"
              >
                Give feedback
              </a>
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    ),
  },
];
