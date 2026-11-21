import { Dialog, DialogContent } from "@mcpjam/design-system/dialog";
import {
  FeatureSpotlight,
  FeatureSpotlightAnchor,
  FeatureSpotlightContent,
} from "@mcpjam/design-system/feature-spotlight";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useAnnouncementSlot } from "./announcement-slot";

type AnnouncementProps = {
  eligible: boolean;
  onDismiss: () => void;
};

export function AnnouncementDialog({
  eligible,
  onDismiss,
  ...content
}: AnnouncementProps &
  Omit<ComponentPropsWithoutRef<typeof DialogContent>, "forceMount">) {
  const { open, contentRef } = useAnnouncementSlot(eligible);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent {...content} ref={contentRef} />
    </Dialog>
  );
}

export function AnnouncementSpotlight({
  eligible,
  anchor,
  onDismiss,
  onShown,
  ...content
}: AnnouncementProps &
  Omit<ComponentPropsWithoutRef<typeof FeatureSpotlightContent>, "forceMount"> & {
    anchor: ReactNode;
    onShown?: () => void;
  }) {
  const { open, contentRef } = useAnnouncementSlot(eligible);
  const notifyShown = useEffectEvent(() => onShown?.());
  useEffect(() => {
    if (open) notifyShown();
  }, [open]);

  return (
    <FeatureSpotlight open={open} onOpenChange={(next) => !next && onDismiss()}>
      <FeatureSpotlightAnchor>{anchor}</FeatureSpotlightAnchor>
      <FeatureSpotlightContent {...content} ref={contentRef} />
    </FeatureSpotlight>
  );
}

export function AnnouncementToast({
  eligible,
  id,
  duration,
  beforeShow,
  render,
}: {
  eligible: boolean;
  id: string;
  duration: number;
  beforeShow?: () => boolean;
  render: (dismiss: () => void) => ReactNode;
}) {
  const [finished, setFinished] = useState(false);
  const showing = useRef(false);
  const { enabled, open, contentRef } = useAnnouncementSlot(
    eligible && !finished,
  );
  const canShow = useEffectEvent(() => beforeShow?.() ?? true);
  const available = enabled && eligible;

  useEffect(() => {
    if (!available) {
      setFinished(false);
      return;
    }
    return () => {
      if (showing.current) {
        showing.current = false;
        toast.dismiss(id);
      }
    };
  }, [available, id]);

  useEffect(() => {
    if (!open || showing.current) return;
    if (!canShow()) {
      setFinished(true);
      return;
    }
    const finish = () => {
      showing.current = false;
      setFinished(true);
    };
    showing.current = true;
    toast.custom(
      (toastId) => (
        <div ref={contentRef}>{render(() => toast.dismiss(toastId))}</div>
      ),
      { id, duration, onDismiss: finish, onAutoClose: finish },
    );
  }, [contentRef, duration, id, open, render]);

  return null;
}
