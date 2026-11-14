import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Pencil } from "lucide-react";
import type { ServerAuth } from "./server-auth";
import type { ServerAuthReveal } from "./hooks/use-server-auth-reveal";
import { useMaskedValues } from "./hooks/use-masked-values";
import { AUTH_METHOD_LABELS } from "./shared/auth-method-labels";
import { CopyValueButton } from "./shared/CopyValueButton";
import { HiddenValuesField } from "./shared/HiddenValuesField";
import { MaskedValueInput } from "./shared/MaskedValueInput";
import { StoredKeyRows } from "./shared/StoredKeyRows";
import {
  RevealTokensButton,
  TokenRevealError,
  TokenValue,
} from "./shared/TokenValue";

interface ServerAuthSummaryProps {
  auth: ServerAuth;
  reveal: ServerAuthReveal;
  /** Binds show/hide state to one server, see `useMaskedValues`. */
  serverKey: string;
  /** Switches the modal to the Config tab, where auth is edited. */
  onEditInConfig: () => void;
}

function methodNote(auth: ServerAuth): string {
  switch (auth.method) {
    case "bearer":
      return "Sends the saved token in the Authorization header.";
    case "none":
      return auth.headers
        ? "Sends only the custom headers below."
        : "Sends requests without credentials.";
    case "auto":
      return "Tries without credentials first, then OAuth if the server asks for it.";
    case "oauth":
      return "Accounts, tokens and the last OAuth trace are below.";
    case "xaa":
      return "Gets access tokens from your identity provider when MCPJam connects.";
  }
}

const NOT_SAVED_TO_PROJECT =
  "Save this server to a project to see its saved values.";

/** Keeps a hidden field level with the rows beside it, which end in an 8x8
 * action button. */
function ActionSpacer() {
  return <div aria-hidden="true" className="h-8 w-8 shrink-0" />;
}

/**
 * The read-only top of the Auth tab: which auth method the server uses, where
 * to change it, and the token and headers it sends. Every HTTP server gets one,
 * so the tab is never blank for servers that don't use OAuth.
 *
 * The token row is the OAuth tokens' own (`TokenValue`), so a bearer token
 * masks, copies and decodes like an access token. Header rows are the Config
 * form's: `MaskedValueInput` in the header editor's name/value layout, with
 * `StoredKeyRows` and `HiddenValuesField` for values still on the server, and
 * copy in the slot where the editor puts its remove button.
 */
export function ServerAuthSummary({
  auth,
  reveal,
  serverKey,
  onEditInConfig,
}: ServerAuthSummaryProps) {
  const maskedHeaders = useMaskedValues(`${serverKey}:headers`);
  const [pendingRevealKey, setPendingRevealKey] = useState<string | null>(null);

  const bearerToken =
    auth.bearer?.kind === "value"
      ? auth.bearer.token
      : reveal.revealed?.bearerToken;
  const headerEntries =
    auth.headers?.kind === "values"
      ? auth.headers.entries
      : (reveal.revealed?.entries ?? []);
  const headersHidden = auth.headers?.kind === "stored" && !reveal.revealed;

  // Same as the header editor: the eye on a stored row fetches the whole set,
  // then uncovers only the row that was clicked.
  useEffect(() => {
    if (!pendingRevealKey) return;
    const index = headerEntries.findIndex(([key]) => key === pendingRevealKey);
    if (index === -1) return;
    maskedHeaders.show(index);
    setPendingRevealKey(null);
  }, [headerEntries, maskedHeaders, pendingRevealKey]);

  // One fetch reveals the token and the headers together, so its error shows
  // once: under the token when there is one, else under the headers.
  const revealError = reveal.error?.message ?? null;
  const onReveal =
    reveal.canReveal && reveal.error?.retryable !== false
      ? () => void reveal.reveal()
      : undefined;

  const showBearer = auth.method === "bearer" && auth.bearer !== null;
  const bearerHidden = showBearer && bearerToken === undefined;
  // A synced bearer token is saved as an Authorization header, so until the
  // names say otherwise, the hidden headers may be that token alone.
  const headerNamesPending =
    headersHidden && reveal.headerNames === null && reveal.canReveal;
  const showHiddenHeaders =
    headersHidden &&
    (reveal.headerNames === null
      ? !(bearerHidden && headerNamesPending)
      : reveal.headerNames.length > 0);
  const showHeaders = headerEntries.length > 0 || showHiddenHeaders;
  const cannotReveal = (bearerHidden || headersHidden) && !reveal.canReveal;

  return (
    <div className="space-y-3 pt-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-muted-foreground">
          Authentication
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={onEditInConfig}
        >
          <Pencil className="h-3 w-3" />
          Edit in Config
        </Button>
      </div>
      <div className="space-y-3 rounded-md bg-muted/40 p-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-foreground">
            {AUTH_METHOD_LABELS[auth.method]}
          </div>
          <p className="text-muted-foreground">{methodNote(auth)}</p>
        </div>

        {showBearer &&
          (bearerToken !== undefined ? (
            <TokenValue label="Token" value={bearerToken} maskedByDefault />
          ) : (
            <div className="space-y-3">
              {revealError && <TokenRevealError message={revealError} />}
              <RevealTokensButton
                label="Reveal token"
                isRevealing={reveal.isRevealing}
                disabled={!onReveal}
                onClick={() => void reveal.reveal()}
              />
            </div>
          ))}

        {showHeaders && (
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <div className="text-xs font-medium text-foreground">
              Custom headers
            </div>
            {headerEntries.length > 0 ? (
              headerEntries.map(([key, value], index) => (
                <div key={key} className="flex items-center gap-1.5">
                  <Input
                    value={key}
                    readOnly
                    aria-readonly
                    spellCheck={false}
                    aria-label={`Header ${index + 1} name`}
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <span
                    aria-hidden="true"
                    className="shrink-0 select-none text-xs text-muted-foreground/70"
                  >
                    :
                  </span>
                  <MaskedValueInput
                    value={value}
                    onChange={() => {}}
                    readOnly
                    visible={maskedHeaders.isVisible(index)}
                    onToggleVisibility={() => maskedHeaders.toggle(index)}
                    inputLabel={`Header ${index + 1} value`}
                    subject={key}
                    className="flex-[1.4]"
                  />
                  <CopyValueButton value={value} subject={`value for ${key}`} />
                </div>
              ))
            ) : reveal.headerNames && reveal.headerNames.length > 0 ? (
              <StoredKeyRows
                keys={reveal.headerNames}
                separator=":"
                rowNoun="Header"
                isRevealing={reveal.isRevealing}
                error={bearerHidden ? null : revealError}
                onReveal={
                  onReveal &&
                  ((key) => {
                    setPendingRevealKey(key);
                    void reveal.reveal();
                  })
                }
              />
            ) : (
              <div className="flex items-start gap-1.5">
                <div className="flex-1">
                  <HiddenValuesField
                    subject="headers"
                    isRevealing={reveal.isRevealing}
                    error={bearerHidden ? null : revealError}
                    onReveal={onReveal}
                  />
                </div>
                <ActionSpacer />
              </div>
            )}
          </div>
        )}

        {cannotReveal && (
          <p className="text-muted-foreground">{NOT_SAVED_TO_PROJECT}</p>
        )}
      </div>
    </div>
  );
}
