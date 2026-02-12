/**
 * CheckoutDialogV2 — Simplified checkout dialog for the MCP Apps path.
 *
 * Displays order summary, collects buyer info + shipping address,
 * and lets the developer either complete the purchase (calling
 * `complete_checkout` on the MCP server) or simulate a failure.
 */

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMinorAmount } from "@/lib/currency";
import { Loader2, ShoppingCart, AlertTriangle, X } from "lucide-react";
import type { CheckoutSession } from "@/shared/acp-types";

type PaymentErrorCode =
  | "payment_declined"
  | "requires_3ds"
  | "processing_error";

/** Error codes that should be displayed in the checkout dialog (host-side). */
const UI_ERROR_CODES = new Set(["payment_declined", "requires_3ds"]);

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
  const [errorType, setErrorType] =
    useState<PaymentErrorCode>("payment_declined");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const currency = session.currency || "usd";

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

      // Check response for UI error messages (payment_declined / requires_3ds)
      const resultObj = result as Record<string, unknown> | null;
      const checkoutSession = resultObj?.checkout_session as
        | Record<string, unknown>
        | undefined;
      const messages = checkoutSession?.messages as
        | Array<{ type?: string; code?: string; text?: string }>
        | undefined;

      const uiError = messages?.find(
        (msg) =>
          msg.type === "error" && msg.code && UI_ERROR_CODES.has(msg.code),
      );

      if (uiError) {
        // UI errors stay in the dialog so the user can retry
        setCheckoutError(uiError.text || `Payment error: ${uiError.code}`);
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

  const handleSimulateFailure = useCallback(() => {
    const errorMessages: Record<PaymentErrorCode, string> = {
      payment_declined: "Payment was declined by the card issuer.",
      requires_3ds:
        "Payment requires 3D Secure authentication (not supported in test mode).",
      processing_error:
        "An unexpected error occurred while processing the payment.",
    };

    if (UI_ERROR_CODES.has(errorType)) {
      // UI errors stay in the dialog for the user to retry
      setCheckoutError(errorMessages[errorType]);
    } else {
      // Non-UI errors are sent to the widget (rejects the promise)
      onError(errorMessages[errorType]);
    }
  }, [errorType, onError]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        onCancel();
      }
      onOpenChange(nextOpen);
    },
    [onCancel, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            Checkout
          </DialogTitle>
          <DialogDescription>
            Session <code className="text-xs">{session.id}</code>
            {session.payment_mode === "test" && (
              <span className="ml-2 inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">
                Test Mode
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Order Summary */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Order Summary</h3>
          <div className="rounded-md border border-border/60 divide-y divide-border/40">
            {session.line_items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {item.image_url && (
                    <img
                      src={item.image_url}
                      alt={item.title}
                      className="h-8 w-8 rounded object-cover flex-shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.title}</div>
                    {item.subtitle && (
                      <div className="text-xs text-muted-foreground truncate">
                        {item.subtitle}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      Qty: {item.quantity}
                    </div>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-2">
                  <div>{formatMinorAmount(item.total, currency)}</div>
                  {item.discount > 0 && (
                    <div className="text-xs text-green-600 dark:text-green-400">
                      -{formatMinorAmount(item.discount, currency)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Totals */}
          {session.totals.length > 0 && (
            <div className="space-y-1 text-sm">
              {session.totals.map((total, i) => (
                <div
                  key={i}
                  className={`flex justify-between ${
                    total.type === "total"
                      ? "font-semibold pt-1 border-t border-border/40"
                      : "text-muted-foreground"
                  }`}
                >
                  <span>{total.display_text}</span>
                  <span>{formatMinorAmount(total.amount, currency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Buyer Information */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Buyer Information</h3>
          <div className="grid gap-2">
            <Input
              placeholder="Full Name *"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              type="email"
              placeholder="Email *"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              type="tel"
              placeholder="Phone *"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>

        {/* Shipping Address */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Shipping Address</h3>
          <div className="grid gap-2">
            <Input
              placeholder="Address Line 1 *"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
            />
            <Input
              placeholder="Address Line 2 (optional)"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
            />
            <div className="grid grid-cols-3 gap-2">
              <Input
                placeholder="City *"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
              <Input
                placeholder="State *"
                value={state}
                onChange={(e) => setState(e.target.value)}
              />
              <Input
                placeholder="Zip *"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Messages from session */}
        {session.messages.length > 0 && (
          <div className="space-y-1">
            {session.messages.map((msg, i) => (
              <div
                key={i}
                className={`text-xs px-2 py-1 rounded ${
                  msg.type === "error"
                    ? "bg-destructive/10 text-destructive"
                    : msg.type === "warning"
                      ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {msg.text}
              </div>
            ))}
          </div>
        )}

        {checkoutError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
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

        {validationError && (
          <p className="text-xs text-destructive">{validationError}</p>
        )}

        <DialogFooter className="flex-col gap-3 sm:flex-col">
          {/* Complete Purchase */}
          <Button
            onClick={handleComplete}
            disabled={isSubmitting}
            className="w-full"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              "Complete Purchase"
            )}
          </Button>

          {/* Simulate Failure */}
          <div className="flex items-center gap-2 w-full">
            <Select
              value={errorType}
              onValueChange={(v) => setErrorType(v as PaymentErrorCode)}
            >
              <SelectTrigger className="flex-1 h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="payment_declined">
                  Payment Declined
                </SelectItem>
                <SelectItem value="requires_3ds">Requires 3DS</SelectItem>
                <SelectItem value="processing_error">
                  Processing Error
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSimulateFailure}
              disabled={isSubmitting}
              className="flex-shrink-0"
            >
              <AlertTriangle className="mr-1 h-3 w-3" />
              Simulate Failure
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
