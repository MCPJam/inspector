/**
 * CheckoutDialogV2 — Refined commerce checkout dialog for the MCP Apps path.
 *
 * Single-panel checkout form. Lets the developer complete the purchase by
 * calling `complete_checkout` on the MCP server.
 */

import { useState, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMinorAmount } from "@/lib/currency";
import { Loader2, ShoppingCart, AlertTriangle, X } from "lucide-react";
import type { CheckoutSession, Message } from "@/shared/acp-types";

/** Error codes that should be displayed in the checkout dialog (host-side). */
const UI_ERROR_CODES = new Set(["payment_declined", "requires_3ds"]);

/**
 * Extract checkout messages from a CallToolResult.
 *
 * The result from onCallTool is an MCP CallToolResult envelope:
 *   { content: ContentBlock[], structuredContent?: { ... } }
 *
 * Per the ACP spec, structuredContent contains checkout session fields
 * directly (flat format), so messages live at structuredContent.messages.
 */
function extractCheckoutMessages(result: unknown): Message[] | undefined {
  const obj = result as Record<string, unknown> | null;
  if (!obj) return undefined;

  const structured = obj.structuredContent as
    | Record<string, unknown>
    | undefined;
  if (structured && Array.isArray(structured.messages)) {
    return structured.messages as Message[];
  }

  return undefined;
}

interface CheckoutDialogV2Props {
  session: CheckoutSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called on successful checkout — resolves the widget's promise. */
  onComplete: (result: unknown) => void;
  /** Called on non-UI errors — rejects the widget's promise. */
  onError: (error: string) => void;
  onCancel: () => void;
  onCallTool: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

function generatePaymentToken(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `tok_sim_${Date.now()}_${hex}`;
}

export function CheckoutDialogV2({
  session,
  open,
  onOpenChange,
  onComplete,
  onError,
  onCancel,
  onCallTool,
}: CheckoutDialogV2Props) {
  // Buyer info
  const [name, setName] = useState(session.buyer?.name ?? "");
  const [email, setEmail] = useState(session.buyer?.email ?? "");
  const [phone, setPhone] = useState(session.buyer?.phone ?? "");

  // Shipping address
  const [line1, setLine1] = useState(session.fulfillment_address?.line1 ?? "");
  const [line2, setLine2] = useState(session.fulfillment_address?.line2 ?? "");
  const [city, setCity] = useState(session.fulfillment_address?.city ?? "");
  const [state, setState] = useState(session.fulfillment_address?.state ?? "");
  const [postalCode, setPostalCode] = useState(
    session.fulfillment_address?.postal_code ?? "",
  );

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const currency = session.currency || "usd";
  const totalLine = session.totals.find((t) => t.type === "total");
  const ctaLabel = totalLine
    ? `Pay ${formatMinorAmount(totalLine.amount, currency)}`
    : "Complete Purchase";

  const handleComplete = useCallback(async () => {
    const missing = [
      !name.trim() && "Name",
      !email.trim() && "Email",
      !phone.trim() && "Phone",
      !line1.trim() && "Address",
      !city.trim() && "City",
      !state.trim() && "State",
      !postalCode.trim() && "Zip Code",
    ].filter(Boolean) as string[];

    if (missing.length > 0) {
      setValidationError(`Missing required fields: ${missing.join(", ")}`);
      return;
    }

    setValidationError(null);
    setCheckoutError(null);
    setIsSubmitting(true);
    try {
      const token = generatePaymentToken();
      const buyer = { name, email, phone };
      const payment_data = {
        token,
        provider: session.payment_provider.provider,
        billing_address: {
          line1,
          line2,
          city,
          state,
          postal_code: postalCode,
          country: "US",
        },
      };

      const result = await onCallTool("complete_checkout", {
        checkout_session_id: session.id,
        buyer,
        payment_data,
      });

      // Check response for UI error messages (ACP server-side errors).
      // The result is an MCP CallToolResult envelope — extract messages
      // from structuredContent or text content blocks.
      const messages = extractCheckoutMessages(result);
      const uiError = messages?.find(
        (msg) =>
          msg.type === "error" && msg.code && UI_ERROR_CODES.has(msg.code),
      );

      if (uiError) {
        // UI errors stay in the dialog so the user can retry
        setCheckoutError(uiError.content || `Checkout error: ${uiError.code}`);
      } else {
        onComplete(result);
      }
    } catch (err) {
      // Tool call failures are non-UI errors — reject the widget's promise
      onError(
        err instanceof Error ? err.message : "Checkout completion failed",
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    name,
    email,
    phone,
    line1,
    line2,
    city,
    state,
    postalCode,
    session.id,
    session.payment_provider.provider,
    onCallTool,
    onComplete,
    onError,
  ]);

  const autofill = useCallback(() => {
    setName("John Doe");
    setEmail("john.doe@example.com");
    setPhone("(555) 867-5309");
    setLine1("123 Main St");
    setLine2("Apt 4B");
    setCity("San Francisco");
    setState("CA");
    setPostalCode("94102");
    setValidationError(null);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        onCancel();
      }
      onOpenChange(nextOpen);
    },
    [onCancel, onOpenChange],
  );

  const legalLinks = session.links.filter(
    (l) =>
      l.type === "terms_of_use" ||
      l.type === "terms_of_service" ||
      l.type === "privacy_policy",
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[480px] p-0 gap-0 rounded-2xl overflow-hidden"
        showCloseButton={false}
      >
        <div className="max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                <ShoppingCart className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">
                    Checkout
                  </h2>
                  {session.payment_mode === "test" && (
                    <Badge
                      variant="outline"
                      className="border-warning/40 bg-warning/10 text-warning-foreground text-[10px] px-1.5 py-0"
                    >
                      Test
                    </Badge>
                  )}
                </div>
                <code className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-md inline-block mt-0.5 max-w-[200px] truncate">
                  {session.id}
                </code>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
              aria-label="Close checkout"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 pb-6 space-y-5">
            {/* Order Summary */}
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Order Summary
              </h3>
              {session.totals.length > 0 && (
                <div className="rounded-xl border border-border overflow-hidden bg-muted/30 px-3 py-2.5 space-y-1 text-sm">
                  {session.totals.map((total, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex justify-between",
                        total.type === "total"
                          ? "font-semibold text-foreground pt-1 border-t border-border/40"
                          : "text-muted-foreground",
                      )}
                    >
                      <span>{total.display_text}</span>
                      <span>{formatMinorAmount(total.amount, currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Buyer Information — Stacked input group */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Buyer Information
                </h3>
                <button
                  type="button"
                  onClick={autofill}
                  className="text-[10px] font-medium text-muted-foreground hover:text-foreground border border-border rounded-md px-2 py-0.5 transition-colors hover:bg-muted/80"
                >
                  Autofill all fields
                </button>
              </div>
              <div className="rounded-xl border border-border overflow-hidden">
                <StackedField
                  label="Full Name"
                  value={name}
                  onChange={setName}
                />
                <StackedField
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  borderTop
                />
                <StackedField
                  label="Phone"
                  type="tel"
                  value={phone}
                  onChange={setPhone}
                  borderTop
                />
              </div>
            </div>

            {/* Shipping Address — Stacked input group */}
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Shipping Address
              </h3>
              <div className="rounded-xl border border-border overflow-hidden">
                <StackedField
                  label="Address Line 1"
                  value={line1}
                  onChange={setLine1}
                />
                <StackedField
                  label="Address Line 2 (optional)"
                  value={line2}
                  onChange={setLine2}
                  borderTop
                />
                {/* City / State / ZIP row */}
                <div className="flex border-t border-border/50">
                  <div className="flex-1">
                    <StackedField
                      label="City"
                      value={city}
                      onChange={setCity}
                    />
                  </div>
                  <div className="w-px bg-border/50" />
                  <div className="flex-1">
                    <StackedField
                      label="State"
                      value={state}
                      onChange={setState}
                    />
                  </div>
                  <div className="w-px bg-border/50" />
                  <div className="flex-1">
                    <StackedField
                      label="ZIP"
                      value={postalCode}
                      onChange={setPostalCode}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Session messages */}
            {session.messages.length > 0 && (
              <div className="space-y-1">
                {session.messages.map((msg, i) => (
                  <div
                    key={i}
                    className={cn(
                      "text-xs px-2.5 py-1.5 rounded-lg",
                      msg.type === "error"
                        ? "bg-destructive/10 text-destructive"
                        : msg.type === "warning"
                          ? "bg-warning/10 text-warning-foreground"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {msg.content}
                  </div>
                ))}
              </div>
            )}

            {/* Checkout error banner */}
            {checkoutError && (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <div className="flex-1 text-xs text-destructive">
                  {checkoutError}
                </div>
                <button
                  type="button"
                  onClick={() => setCheckoutError(null)}
                  className="text-destructive/60 hover:text-destructive flex-shrink-0"
                  aria-label="Dismiss error"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Validation error */}
            {validationError && (
              <p className="text-xs text-destructive">{validationError}</p>
            )}

            {/* CTA Button */}
            <Button
              onClick={handleComplete}
              disabled={isSubmitting}
              className="w-full rounded-full h-12 text-sm font-semibold"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                ctaLabel
              )}
            </Button>

            {/* Legal links footer */}
            {legalLinks.length > 0 && (
              <div className="border-t border-border/50 pt-3">
                <p className="text-[10px] text-muted-foreground text-center">
                  By completing this purchase you agree to the{" "}
                  {legalLinks.map((link, i) => (
                    <span key={link.type}>
                      {i > 0 && (i === legalLinks.length - 1 ? " and " : ", ")}
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground transition-colors"
                      >
                        {link.text}
                      </a>
                    </span>
                  ))}
                  .
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Stacked field ────────────────────────────────────────────────────────── */

function StackedField({
  label,
  value,
  onChange,
  type = "text",
  borderTop = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  borderTop?: boolean;
}) {
  return (
    <div className={cn("relative", borderTop && "border-t border-border/50")}>
      <label className="absolute left-3 top-1.5 text-[10px] text-muted-foreground pointer-events-none">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-12 pt-5 pb-1 px-3 text-sm text-foreground bg-transparent border-0 outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/50"
      />
    </div>
  );
}
