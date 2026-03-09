import type { ReactNode } from "react";

export type HeaderIpc = {
  id: string;
  render: (context: { dismiss: () => void }) => ReactNode;
};

// Append new IPC entries here. Use a new unique `id` so previously dismissed
// banners will not automatically reappear.
export const headerIpcs: HeaderIpc[] = [];
