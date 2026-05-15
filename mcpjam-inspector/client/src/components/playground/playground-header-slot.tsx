import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Portal slot so the Playground tab can render its own toolbar inside the
 * top app header (`AuthUpperArea`) instead of as a second strip below it.
 * The top header owns the DOM node; the playground tab "teleports" its
 * header JSX into that node when mounted. With no consumer portaling in,
 * the target renders an empty div — fine.
 */

interface SlotContextValue {
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
}

const SlotContext = createContext<SlotContextValue | null>(null);

export function PlaygroundHeaderSlotProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SlotContext.Provider value={{ slot, setSlot }}>
      {children}
    </SlotContext.Provider>
  );
}

/**
 * Renders an empty div in the host position; registers it with the provider
 * so consumers can portal into it. Renders nothing visually when no consumer
 * is portaling.
 */
export function PlaygroundHeaderSlotTarget({
  className,
}: {
  className?: string;
}) {
  const ctx = useContext(SlotContext);
  return (
    <div
      ref={(el) => {
        ctx?.setSlot(el);
      }}
      className={className}
    />
  );
}

/**
 * Portals children into the registered slot target. Returns null on the
 * first render before the target ref is attached; a second render lands the
 * content after the ref state settles.
 */
export function PlaygroundHeaderSlotContent({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = useContext(SlotContext);
  if (!ctx?.slot) return null;
  return createPortal(children, ctx.slot);
}
