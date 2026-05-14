import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { PaneId } from "@/shared/playground-view";

export type PaneSide = "left" | "right";

export interface PaneRenderContext {
  /** Side the pane is currently docked on. */
  side: PaneSide;
  /** Caller-supplied hook for "close this pane" (removes it from layout). */
  onClose: () => void;
}

export interface PaneDescriptor {
  id: PaneId;
  title: string;
  icon: LucideIcon;
  /** Default side when the pane is first opened by the user. */
  defaultSide: PaneSide;
  renderBody: (ctx: PaneRenderContext) => ReactNode;
}

export type { PaneId };
