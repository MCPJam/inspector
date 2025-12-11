import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { X } from "lucide-react";

export type HeaderIpc = {
  id: string;
  render: (context: { dismiss: () => void }) => ReactNode;
};

// Append new IPC entries here. Use a new unique `id` so previously dismissed
// banners will not automatically reappear.
export const headerIpcs: HeaderIpc[] = [
  {
    id: "ipc-2025-app-builder-1-1-1",
    render: ({ dismiss }) => (
      <div className="no-drag bg-orange-200 px-4 py-2 text-gray-900 lg:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1">
            <p className="text-sm font-normal leading-snug">
              Try the new App Builder for ChatGPT Apps and MCP Apps
            </p>
            <a
              href="#ui-playground"
              onClick={dismiss}
              className="text-sm font-normal text-orange-700 hover:text-orange-800 underline underline-offset-2"
            >
              Try it now
            </a>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={dismiss}
            className="hover:bg-orange-200 p-1 h-8 w-8"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>
    ),
  },
];
