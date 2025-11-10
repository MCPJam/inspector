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
    id: "ipc-2025-oauth-debugger-1-1-1",
    render: ({ dismiss }) => (
      <div className="no-drag bg-orange-200 px-4 py-2 text-gray-900 lg:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1">
            <p className="text-sm font-normal leading-snug">
              Try the new OAuth Debugger
            </p>
            <a
              href="#oauth-flow"
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
  {
    id: "ipc-2024-beta-feedback",
    render: ({ dismiss }) => (
      <div className="no-drag bg-orange-200 px-4 py-2 text-gray-900 lg:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1">
            <p className="text-sm font-normal leading-snug">
              You can now try frontier models in the playground, for free!
            </p>
            <a
              href="#chat"
              onClick={dismiss}
              className="text-sm font-normal text-orange-700 hover:text-orange-800 underline underline-offset-2"
            >
              Try it now
            </a>
            <div className="hidden sm:flex items-center gap-2 ml-2">
              <img
                src="/claude_logo.png"
                alt="Claude"
                className="w-6 h-6 object-contain opacity-80"
              />
              <img
                src="/openai_logo.png"
                alt="OpenAI"
                className="w-6 h-6 object-contain opacity-80"
              />
              <img
                src="/google_logo.png"
                alt="Google"
                className="w-6 h-6 object-contain opacity-80"
              />
              <img
                src="/meta_logo.svg"
                alt="Meta"
                className="w-6 h-6 object-contain opacity-80"
              />
              <img
                src="/grok_light.svg"
                alt="Grok"
                className="w-6 h-6 object-contain opacity-80"
              />
            </div>
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
