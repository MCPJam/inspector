import { useId, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { FieldError } from "@mcpjam/design-system/field-error";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@mcpjam/design-system/cn";
import { copyToClipboard } from "@/lib/clipboard";
import type { SubscribeForm } from "./use-subscribe-form";

const choices = [
  { kind: "local", label: "This machine", detail: "For servers that can reach this machine over HTTP." },
  { kind: "custom", label: "Custom URL", detail: "Use your own reverse proxy or tunnel." },
] as const;

export function CallbackField({
  form,
  localCallbackBase,
}: {
  form: SubscribeForm;
  localCallbackBase?: string;
}) {
  const id = useId();
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed">();
  const base = form.callbackUrl?.replace(/\/+$/, "");
  const custom = form.receiverKind === "custom";
  const rule = custom && base && localCallbackBase
    ? `${base}/* → ${localCallbackBase}/*`
    : null;
  const customFlag = custom && base ? ` --public-url '${base.replaceAll("'", "'\\''")}'` : "";
  const cliFlags = `--mode webhook${customFlag}${form.needsAcknowledgement ? " --insecure-local-receiver" : ""}`;

  return (
    <fieldset className="space-y-2 pt-2">
      <legend className="text-xs font-medium">Callback</legend>
      {choices.map(({ kind, label, detail }) => (
        <label
          key={kind}
          className={cn(
            "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-1.5 text-xs",
            form.receiverKind === kind
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent",
          )}
        >
          <input
            type="radio"
            name={`${id}-receiver`}
            checked={form.receiverKind === kind}
            aria-label={label}
            aria-describedby={`${id}-${kind}-hint`}
            onChange={() => {
              form.setReceiverKind(kind);
              setCopyStatus(undefined);
            }}
            className="mt-0.5 accent-primary"
          />
          <span>
            <span className="block font-medium">{label}</span>
            <span id={`${id}-${kind}-hint`} className="text-[11px] text-muted-foreground">
              {detail}
            </span>
          </span>
        </label>
      ))}
      {custom ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-url`} className="text-xs">Callback URL</Label>
          <Input
            id={`${id}-url`}
            value={form.customCallbackUrl}
            onChange={(event) => {
              form.setCustomCallbackUrl(event.target.value);
              setCopyStatus(undefined);
            }}
            aria-invalid={Boolean(form.callbackUrlError)}
            aria-describedby={form.callbackUrlError ? `${id}-url-error` : undefined}
            placeholder="https://proxy.example.com/mcp-hooks"
            className="h-8 text-xs"
            spellCheck={false}
          />
          <FieldError id={`${id}-url-error`} className="text-xs">
            {form.callbackUrlError}
          </FieldError>
        </div>
      ) : null}
      {form.needsAcknowledgement ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-http`}
            checked={form.acknowledged}
            onCheckedChange={(checked) => form.setAcknowledged(checked === true)}
          />
          <Label htmlFor={`${id}-http`} className="text-xs">
            Allow plain HTTP for local development. Some servers require HTTPS.
          </Label>
        </div>
      ) : null}
      {rule ? (
        <div className="space-y-1 rounded-md border border-border p-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Proxy forwarding rule</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Copy forwarding rule"
              onClick={async () => setCopyStatus(await copyToClipboard(rule) ? "copied" : "failed")}
            >
              <Copy aria-hidden="true" className="size-3" />
              {copyStatus === "copied" ? "Copied" : "Copy"}
            </Button>
          </div>
          <code className="break-all">{rule}</code>
          <p className="text-muted-foreground">
            Keep the path after the prefix, request body, and webhook headers intact.
          </p>
          <FieldError className="text-xs">
            {copyStatus === "failed" ? "Couldn't copy the forwarding rule. Select the rule and copy it." : null}
          </FieldError>
        </div>
      ) : null}
      {!custom || base ? (
        <div className="space-y-0.5 text-[11px] text-muted-foreground">
          <p>CLI flags</p>
          <code className="break-all text-foreground">{cliFlags}</code>
          {custom ? <p>For the CLI, forward the public prefix to the listener printed by events watch.</p> : null}
        </div>
      ) : null}
    </fieldset>
  );
}
