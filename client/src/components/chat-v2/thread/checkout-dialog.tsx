import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatMinorAmount } from "@/lib/currency";
import { Loader2, CreditCard, AlertCircle, CheckCircle2 } from "lucide-react";
import type {
  CheckoutSession,
  Buyer,
  PaymentData,
  Address,
  CompleteCheckoutSessionResponse,
} from "@/shared/acp-types";

type CheckoutStep = "review" | "payment" | "processing" | "success" | "error";

interface CheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkoutSession: CheckoutSession | null;
  checkoutCallId: number | null;
  onRespond: (payload: { result?: unknown; error?: string }) => void;
  /** Call the complete_checkout MCP tool */
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ) => Promise<unknown>;
}

// Test card numbers per OpenAI docs
const TEST_CARDS = {
  success: "4242424242424242",
  decline: "4000000000000002",
  requires3ds: "4000002500003155",
};

function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 16);
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  if (digits.length >= 2) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return digits;
}

export function CheckoutDialog({
  open,
  onOpenChange,
  checkoutSession,
  checkoutCallId,
  onRespond,
  onCallTool,
}: CheckoutDialogProps) {
  const [step, setStep] = useState<CheckoutStep>("review");
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [cardholderName, setCardholderName] = useState("");
  const [email, setEmail] = useState("");
  const [billingAddress, setBillingAddress] = useState<Partial<Address>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [completedOrder, setCompletedOrder] =
    useState<CompleteCheckoutSessionResponse | null>(null);

  const resetForm = useCallback(() => {
    setStep("review");
    setCardNumber("");
    setExpiry("");
    setCvc("");
    setCardholderName("");
    setEmail("");
    setBillingAddress({});
    setErrorMessage(null);
    setCompletedOrder(null);
  }, []);

  // Reset form when checkout session changes
  useEffect(() => {
    if (checkoutSession?.id) {
      resetForm();
    }
  }, [checkoutSession?.id, resetForm]);

  const handleClose = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        // If closing during review/payment without completing, send cancel
        if (
          checkoutCallId != null &&
          (step === "review" || step === "payment")
        ) {
          onRespond({ error: "Checkout canceled" });
        }
        resetForm();
      }
      onOpenChange(newOpen);
    },
    [checkoutCallId, step, onRespond, onOpenChange, resetForm],
  );

  const handleProceedToPayment = useCallback(() => {
    setStep("payment");
  }, []);

  const handleSubmitPayment = useCallback(async () => {
    if (!checkoutSession || checkoutCallId == null) return;

    const rawCardNumber = cardNumber.replace(/\s/g, "");

    // Validate form
    if (rawCardNumber.length !== 16) {
      setErrorMessage("Please enter a valid 16-digit card number");
      return;
    }
    if (expiry.length !== 5) {
      setErrorMessage("Please enter a valid expiry date (MM/YY)");
      return;
    }
    if (cvc.length < 3) {
      setErrorMessage("Please enter a valid CVC");
      return;
    }
    if (!cardholderName.trim()) {
      setErrorMessage("Please enter the cardholder name");
      return;
    }

    setErrorMessage(null);
    setStep("processing");

    // Generate mock payment token
    const mockToken = `tok_${Date.now()}_${rawCardNumber.slice(-4)}`;
    const provider = checkoutSession.payment_provider?.provider || "stripe";

    const buyer: Buyer = {
      name: cardholderName.trim(),
      email: email.trim() || undefined,
    };

    // Build billing address if provided
    const hasBillingAddress =
      billingAddress.line1 &&
      billingAddress.city &&
      billingAddress.postal_code &&
      billingAddress.country;

    const paymentData: PaymentData = {
      token: mockToken,
      provider,
      billing_address: hasBillingAddress
        ? (billingAddress as Address)
        : undefined,
    };

    // If onCallTool is provided, call the complete_checkout MCP tool
    if (onCallTool) {
      try {
        const result = await onCallTool("complete_checkout", {
          checkout_session_id: checkoutSession.id,
          buyer,
          payment_data: paymentData,
        });

        // Check if the result indicates an error
        const resultObj = result as Record<string, unknown> | null;
        if (resultObj?.isError || resultObj?.error) {
          const errorMsg =
            typeof resultObj.error === "string"
              ? resultObj.error
              : "Payment processing failed";
          setErrorMessage(errorMsg);
          setStep("error");
          return;
        }

        // Check for structured content response
        const structuredContent = resultObj?.structuredContent as
          | CompleteCheckoutSessionResponse
          | undefined;
        if (structuredContent?.checkout_session && structuredContent?.order) {
          setCompletedOrder(structuredContent);
          setStep("success");
          return;
        }

        // Check for direct response format
        if (resultObj?.checkout_session && resultObj?.order) {
          setCompletedOrder(resultObj as unknown as CompleteCheckoutSessionResponse);
          setStep("success");
          return;
        }

        // Fallback: simulate success if tool returned something
        setCompletedOrder({
          checkout_session: {
            ...checkoutSession,
            status: "completed",
            buyer,
          },
          order: {
            id: `order_${Date.now()}`,
            checkout_session_id: checkoutSession.id,
            permalink_url: "",
          },
        });
        setStep("success");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Payment failed";
        setErrorMessage(errMsg);
        setStep("error");
      }
    } else {
      // No onCallTool - simulate based on card number (legacy behavior)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      if (rawCardNumber === TEST_CARDS.decline) {
        setErrorMessage("Card declined. Please try a different payment method.");
        setStep("error");
        return;
      }

      if (rawCardNumber === TEST_CARDS.requires3ds) {
        setErrorMessage(
          "This card requires 3D Secure authentication (not supported in mock).",
        );
        setStep("error");
        return;
      }

      // Success
      setCompletedOrder({
        checkout_session: {
          ...checkoutSession,
          status: "completed",
          buyer,
        },
        order: {
          id: `order_${Date.now()}`,
          checkout_session_id: checkoutSession.id,
          permalink_url: "",
        },
      });
      setStep("success");
    }
  }, [
    checkoutSession,
    checkoutCallId,
    cardNumber,
    expiry,
    cvc,
    cardholderName,
    email,
    billingAddress,
    onCallTool,
  ]);

  const handleConfirmSuccess = useCallback(() => {
    if (completedOrder) {
      onRespond({ result: completedOrder });
    }
    resetForm();
    onOpenChange(false);
  }, [completedOrder, onRespond, resetForm, onOpenChange]);

  const handleRetry = useCallback(() => {
    setErrorMessage(null);
    setStep("payment");
  }, []);

  const handleSimulateFailure = useCallback(() => {
    if (checkoutCallId == null) return;
    onRespond({ error: "Simulated checkout failure" });
    resetForm();
    onOpenChange(false);
  }, [checkoutCallId, onRespond, resetForm, onOpenChange]);

  // Calculate total from session
  const grandTotal =
    checkoutSession?.totals?.find((t) => t.type === "total")?.amount ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "review" && "Review Order"}
            {step === "payment" && "Payment"}
            {step === "processing" && "Processing Payment"}
            {step === "success" && "Order Complete"}
            {step === "error" && "Payment Failed"}
          </DialogTitle>
        </DialogHeader>

        {/* Step: Review */}
        {step === "review" && (
          <>
            <ScrollArea className="max-h-[50vh] pr-4">
              {!checkoutSession ? (
                <div className="text-sm text-muted-foreground">
                  No checkout session provided.
                </div>
              ) : (
                <div className="space-y-4 text-sm">
                  {/* Line Items */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium">Items</div>
                    {checkoutSession.line_items?.length ? (
                      <div className="space-y-2">
                        {checkoutSession.line_items.map((item) => (
                          <div
                            key={item.id}
                            className="rounded-md border border-border/50 p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium truncate">
                                  {item.title}
                                </div>
                                {item.subtitle && (
                                  <div className="text-xs text-muted-foreground truncate">
                                    {item.subtitle}
                                  </div>
                                )}
                                <div className="text-xs text-muted-foreground">
                                  Qty: {item.quantity}
                                </div>
                              </div>
                              <div className="text-right tabular-nums">
                                <div className="font-medium">
                                  {formatMinorAmount(
                                    item.total ?? item.subtotal ?? 0,
                                    checkoutSession.currency,
                                  )}
                                </div>
                                {typeof item.tax === "number" && item.tax > 0 && (
                                  <div className="text-xs text-muted-foreground">
                                    Tax:{" "}
                                    {formatMinorAmount(
                                      item.tax,
                                      checkoutSession.currency,
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No line items.
                      </div>
                    )}
                  </div>

                  {/* Totals */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium">Summary</div>
                    {checkoutSession.totals?.length ? (
                      <div className="rounded-md border border-border/50">
                        {checkoutSession.totals.map((t, idx) => (
                          <div
                            key={`${t.type}-${idx}`}
                            className={`flex items-center justify-between gap-2 px-3 py-2 border-b last:border-b-0 border-border/50 ${
                              t.type === "total" ? "font-medium" : ""
                            }`}
                          >
                            <div className="text-muted-foreground">
                              {t.display_text || t.type}
                            </div>
                            <div className="tabular-nums">
                              {formatMinorAmount(
                                t.amount,
                                checkoutSession.currency,
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No totals.
                      </div>
                    )}
                  </div>

                  {/* Links */}
                  {!!checkoutSession.links?.length && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium">Policies</div>
                      <div className="space-y-1">
                        {checkoutSession.links.map((l, idx) => (
                          <div key={`${l.type}-${idx}`} className="text-xs">
                            <a
                              href={l.url}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-2 text-muted-foreground hover:text-foreground"
                            >
                              {l.text || l.type}
                            </a>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Test mode indicator */}
                  {checkoutSession.payment_mode === "test" && (
                    <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
                      Test mode: Use card 4242 4242 4242 4242 for success
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSimulateFailure}
                disabled={checkoutSession == null || checkoutCallId == null}
                className="text-xs text-muted-foreground"
              >
                Simulate Failure
              </Button>
              <Button
                onClick={handleProceedToPayment}
                disabled={checkoutSession == null || checkoutCallId == null}
              >
                Proceed to Payment
              </Button>
            </div>
          </>
        )}

        {/* Step: Payment */}
        {step === "payment" && checkoutSession && (
          <>
            <div className="space-y-4">
              {/* Card form */}
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="cardNumber" className="text-xs">
                    Card Number
                  </Label>
                  <div className="relative">
                    <CreditCard className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="cardNumber"
                      placeholder="4242 4242 4242 4242"
                      value={cardNumber}
                      onChange={(e) =>
                        setCardNumber(formatCardNumber(e.target.value))
                      }
                      className="pl-10 font-mono"
                      autoComplete="cc-number"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="expiry" className="text-xs">
                      Expiry
                    </Label>
                    <Input
                      id="expiry"
                      placeholder="MM/YY"
                      value={expiry}
                      onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                      className="font-mono"
                      autoComplete="cc-exp"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cvc" className="text-xs">
                      CVC
                    </Label>
                    <Input
                      id="cvc"
                      placeholder="123"
                      value={cvc}
                      onChange={(e) =>
                        setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))
                      }
                      className="font-mono"
                      autoComplete="cc-csc"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cardholderName" className="text-xs">
                    Cardholder Name
                  </Label>
                  <Input
                    id="cardholderName"
                    placeholder="John Doe"
                    value={cardholderName}
                    onChange={(e) => setCardholderName(e.target.value)}
                    autoComplete="cc-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email" className="text-xs">
                    Email (optional)
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="john@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>

                {/* Billing Address */}
                <div className="space-y-2 pt-2 border-t">
                  <div className="text-xs font-medium">
                    Billing Address (optional)
                  </div>
                  <Input
                    placeholder="Address line 1"
                    value={billingAddress.line1 || ""}
                    onChange={(e) =>
                      setBillingAddress((prev) => ({
                        ...prev,
                        line1: e.target.value,
                      }))
                    }
                    autoComplete="address-line1"
                  />
                  <Input
                    placeholder="Address line 2"
                    value={billingAddress.line2 || ""}
                    onChange={(e) =>
                      setBillingAddress((prev) => ({
                        ...prev,
                        line2: e.target.value,
                      }))
                    }
                    autoComplete="address-line2"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="City"
                      value={billingAddress.city || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          city: e.target.value,
                        }))
                      }
                      autoComplete="address-level2"
                    />
                    <Input
                      placeholder="State/Province"
                      value={billingAddress.state || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          state: e.target.value,
                        }))
                      }
                      autoComplete="address-level1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Postal code"
                      value={billingAddress.postal_code || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          postal_code: e.target.value,
                        }))
                      }
                      autoComplete="postal-code"
                    />
                    <Input
                      placeholder="Country (e.g., US)"
                      value={billingAddress.country || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          country: e.target.value.toUpperCase().slice(0, 2),
                        }))
                      }
                      autoComplete="country"
                      maxLength={2}
                    />
                  </div>
                </div>
              </div>

              {/* Error message */}
              {errorMessage && (
                <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {errorMessage}
                </div>
              )}

              {/* Test card hint */}
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium">Test cards:</span>
                <br />
                Success: 4242 4242 4242 4242
                <br />
                Decline: 4000 0000 0000 0002
              </div>

              {/* Total */}
              <div className="flex items-center justify-between text-sm font-medium pt-2 border-t">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMinorAmount(grandTotal, checkoutSession.currency)}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep("review")}>
                Back
              </Button>
              <Button onClick={handleSubmitPayment}>
                Pay {formatMinorAmount(grandTotal, checkoutSession.currency)}
              </Button>
            </div>
          </>
        )}

        {/* Step: Processing */}
        {step === "processing" && (
          <div className="flex flex-col items-center justify-center py-8 gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">
              Processing payment...
            </div>
            <div className="text-xs text-muted-foreground">
              {onCallTool
                ? "Calling complete_checkout tool..."
                : "Simulating payment processing..."}
            </div>
          </div>
        )}

        {/* Step: Success */}
        {step === "success" && completedOrder && (
          <div className="flex flex-col items-center justify-center py-6 gap-4">
            <div className="rounded-full bg-green-500/10 p-3">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
            <div className="text-center space-y-1">
              <div className="font-medium">Payment Successful!</div>
              <div className="text-sm text-muted-foreground">
                Order ID: {completedOrder.order.id}
              </div>
            </div>
            <div className="w-full mt-4">
              <Button className="w-full" onClick={handleConfirmSuccess}>
                Done
              </Button>
            </div>
          </div>
        )}

        {/* Step: Error */}
        {step === "error" && (
          <div className="flex flex-col items-center justify-center py-6 gap-4">
            <div className="rounded-full bg-destructive/10 p-3">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <div className="text-center space-y-1">
              <div className="font-medium">Payment Failed</div>
              <div className="text-sm text-muted-foreground">
                {errorMessage || "An error occurred during payment processing."}
              </div>
            </div>
            <div className="flex gap-2 w-full mt-4">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  onRespond({ error: errorMessage || "Payment failed" });
                  resetForm();
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleRetry}>
                Try Again
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
