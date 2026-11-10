import { useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import type {
  CheckedCursorKey,
  CursorProviderView,
} from "@/hooks/useCursorProvider";
import { useSettingsDraft } from "../settings/SettingsDraftProvider";
import { ProviderKeyField } from "./ProviderKeyField";

type Props = {
  view: CursorProviderView;
  checkKey: (key: string) => Promise<CheckedCursorKey>;
  saveKey: (
    key: string,
    identity: CheckedCursorKey["identity"],
  ) => Promise<CheckedCursorKey>;
  onClose: () => void;
};

export function CursorKeyDialog({ view, checkKey, saveKey, onClose }: Props) {
  const [key, setKey] = useState("");
  const [checked, setChecked] = useState<CheckedCursorKey>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"check" | "save">();
  const generation = useRef(0);
  const changeKey = (value: string) => {
    generation.current++;
    setKey(value);
    setChecked(undefined);
    setError(undefined);
    setBusy(undefined);
  };
  const close = () => {
    generation.current++;
    onClose();
  };
  useSettingsDraft(!!key, close, busy === "save");

  const check = async () => {
    const request = ++generation.current;
    setBusy("check");
    setError(undefined);
    try {
      const result = await checkKey(key);
      if (request === generation.current) setChecked(result);
    } catch (cause) {
      if (request === generation.current)
        setError(
          convexErrMessage(cause, "Could not check the Cursor key. Try again."),
        );
    } finally {
      if (request === generation.current) setBusy(undefined);
    }
  };
  const save = async () => {
    if (!checked || busy) return;
    setBusy("save");
    try {
      await saveKey(key, checked.identity);
      toast.success("Cursor key saved.");
      close();
    } catch (cause) {
      setChecked(undefined);
      setError(
        convexErrMessage(
          cause,
          "Could not save the Cursor key. Check it again.",
        ),
      );
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy !== "save") close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Cursor</DialogTitle>
          <DialogDescription>
            Cursor and Cursor CLI runs use this organization's Cursor account.
            Use a service account when available.
          </DialogDescription>
        </DialogHeader>
        {view.identity && (
          <p className="text-sm text-muted-foreground">
            Current account: {view.identity.label}
          </p>
        )}
        <ProviderKeyField
          id="org-cursor-key"
          configured={view.configured}
          value={key}
          onChange={changeKey}
          placeholder="Cursor API key"
          error={error}
          disabled={busy === "save"}
        />
        {checked && (
          <div role="status" className="space-y-1 text-sm">
            <p>
              Cursor and Cursor CLI runs in this organization use{" "}
              <strong>{checked.identity.label}</strong>.
            </p>
            <p className="text-muted-foreground">{checked.modelCount} models</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy === "save"}>
            Cancel
          </Button>
          <Button
            onClick={() => void (checked ? save() : check())}
            disabled={!key.trim() || !!busy}
          >
            {busy === "check"
              ? "Checking key..."
              : busy === "save"
                ? "Saving..."
                : checked
                  ? "Save"
                  : "Check key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
