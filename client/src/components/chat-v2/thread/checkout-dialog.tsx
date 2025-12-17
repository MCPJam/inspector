import { useState, useCallback, useEffect, useMemo } from "react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { formatMinorAmount } from "@/lib/currency";
import {
  Loader2,
  CreditCard,
  AlertCircle,
  CheckCircle2,
  Info,
  AlertTriangle,
  Truck,
  Zap,
  Package,
  X,
} from "lucide-react";
import type {
  CheckoutSession,
  Buyer,
  PaymentData,
  Address,
  CompleteCheckoutSessionResponse,
  FulfillmentOption,
  Message,
} from "@/shared/acp-types";

// ============================================================================
// Test Card Definitions (for simulating payment scenarios)
// ============================================================================

type PaymentErrorCode = "payment_declined" | "requires_3ds" | "processing_error";

interface TestCardBehavior {
  behavior: "success" | "decline" | "insufficient_funds" | "expired" | "3ds" | "processing_error";
  errorCode?: PaymentErrorCode;
  errorMessage?: string;
}

const TEST_CARDS: Record<string, { number: string; behavior: TestCardBehavior }> = {
  success: { number: "4242424242424242", behavior: { behavior: "success" } },
  decline_generic: { number: "4000000000000002", behavior: { behavior: "decline", errorCode: "payment_declined", errorMessage: "Your card was declined." } },
  decline_insufficient: { number: "4000000000009995", behavior: { behavior: "insufficient_funds", errorCode: "payment_declined", errorMessage: "Insufficient funds." } },
  decline_expired: { number: "4000000000000069", behavior: { behavior: "expired", errorCode: "payment_declined", errorMessage: "Card has expired." } },
  requires_3ds: { number: "4000000000003155", behavior: { behavior: "3ds", errorCode: "requires_3ds", errorMessage: "3D Secure required." } },
  processing_error: { number: "4000000000000119", behavior: { behavior: "processing_error", errorMessage: "Processing error occurred." } },
};

function getTestCardBehavior(cardNumber: string): TestCardBehavior | null {
  const cleanNumber = cardNumber.replace(/\s/g, "");
  for (const card of Object.values(TEST_CARDS)) {
    if (card.number === cleanNumber) return card.behavior;
  }
  return null;
}

// ============================================================================
// Error Scenarios (Infrastructure/Transport failures)
// ============================================================================

type ErrorScenario = "none" | "network_timeout" | "server_error" | "slow_response";

const ERROR_SCENARIOS: Record<ErrorScenario, { label: string; description: string }> = {
  none: { label: "Normal", description: "Use card behavior" },
  network_timeout: { label: "Timeout", description: "10s network timeout" },
  server_error: { label: "500 Error", description: "Server error" },
  slow_response: { label: "Slow", description: "5s delay" },
};

// Quick-fill test cards for compact UI
const QUICK_FILL_CARDS = [
  { key: "success", label: "✓", title: "Success (4242...)", number: TEST_CARDS.success.number },
  { key: "decline", label: "✗", title: "Decline (0002)", number: TEST_CARDS.decline_generic.number },
  { key: "insufficient", label: "$", title: "Insufficient (9995)", number: TEST_CARDS.decline_insufficient.number },
  { key: "3ds", label: "3D", title: "3D Secure (3155)", number: TEST_CARDS.requires_3ds.number },
  { key: "expired", label: "⏱", title: "Expired (0069)", number: TEST_CARDS.decline_expired.number },
  { key: "error", label: "⚠", title: "Processing Error (0119)", number: TEST_CARDS.processing_error.number },
] as const;

type CheckoutStep =
  | "review"
  | "fulfillment"
  | "payment"
  | "processing"
  | "success"
  | "error";

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
    meta?: Record<string, unknown>
  ) => Promise<unknown>;
}

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

function formatDeliveryWindow(earliest: string, latest: string): string {
  try {
    const earliestDate = new Date(earliest);
    const latestDate = new Date(latest);
    const options: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
    };
    const earliestStr = earliestDate.toLocaleDateString("en-US", options);
    const latestStr = latestDate.toLocaleDateString("en-US", options);
    if (earliestStr === latestStr) return earliestStr;
    return `${earliestStr} - ${latestStr}`;
  } catch {
    return "";
  }
}

function MessageDisplay({ message }: { message: Message }) {
  const icons = {
    info: <Info className="h-4 w-4 flex-shrink-0" />,
    warning: <AlertTriangle className="h-4 w-4 flex-shrink-0" />,
    error: <AlertCircle className="h-4 w-4 flex-shrink-0" />,
  };

  const colors = {
    info: "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400",
    warning:
      "bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400",
    error: "bg-destructive/10 border-destructive/30 text-destructive",
  };

  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${colors[message.type]}`}
    >
      {icons[message.type]}
      <span>{message.text}</span>
    </div>
  );
}

function FulfillmentOptionCard({
  option,
  selected,
  onSelect,
  currency,
}: {
  option: FulfillmentOption;
  selected: boolean;
  onSelect: () => void;
  currency: string;
}) {
  const isShipping = option.type === "shipping";

  return (
    <div
      onClick={onSelect}
      className={`rounded-lg border p-3 cursor-pointer transition-colors ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border/50 hover:border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`rounded-full p-2 ${
            selected ? "bg-primary/10" : "bg-muted"
          }`}
        >
          {isShipping ? (
            <Truck className="h-4 w-4" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">{option.title}</span>
            <span className="text-sm font-medium tabular-nums">
              {option.total === 0
                ? "FREE"
                : formatMinorAmount(option.total, currency)}
            </span>
          </div>
          {option.subtitle && (
            <div className="text-xs text-muted-foreground">{option.subtitle}</div>
          )}
          {isShipping && "carrier_info" in option && (
            <div className="text-xs text-muted-foreground mt-1">
              <span>{option.carrier_info}</span>
              {option.earliest_delivery_time && option.latest_delivery_time && (
                <span className="ml-2">
                  Est. {formatDeliveryWindow(option.earliest_delivery_time, option.latest_delivery_time)}
                </span>
              )}
            </div>
          )}
        </div>
        <RadioGroupItem value={option.id} checked={selected} />
      </div>
    </div>
  );
}

export function CheckoutDialog({
  open,
  onOpenChange,
  checkoutSession: initialSession,
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
  const [errorCode, setErrorCode] = useState<PaymentErrorCode | null>(null);
  const [completedOrder, setCompletedOrder] =
    useState<CompleteCheckoutSessionResponse | null>(null);

  // Session state (can be updated)
  const [checkoutSession, setCheckoutSession] = useState<CheckoutSession | null>(
    initialSession
  );
  const [selectedFulfillmentId, setSelectedFulfillmentId] = useState<
    string | null
  >(null);

  const [isUpdating, setIsUpdating] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [errorScenario, setErrorScenario] = useState<ErrorScenario>("none");

  // Sync initial session and auto-select single fulfillment option
  useEffect(() => {
    if (initialSession) {
      setCheckoutSession(initialSession);
      // Auto-select fulfillment: use existing selection, or auto-select if only one option
      const options = initialSession.fulfillment_options;
      if (initialSession.fulfillment_option_id) {
        setSelectedFulfillmentId(initialSession.fulfillment_option_id);
      } else if (options?.length === 1) {
        // Auto-select the only available option
        setSelectedFulfillmentId(options[0].id);
      } else {
        setSelectedFulfillmentId(null);
      }
    }
  }, [initialSession]);

  const resetForm = useCallback(() => {
    setStep("review");
    setCardNumber("");
    setExpiry("");
    setCvc("");
    setCardholderName("");
    setEmail("");
    setBillingAddress({});
    setErrorMessage(null);
    setErrorCode(null);
    setCompletedOrder(null);
    setSelectedFulfillmentId(null);
    setIsUpdating(false);
    setIsCanceling(false);
    setErrorScenario("none");
  }, []);

  // Handle cancel checkout via MCP tool
  const handleCancelCheckout = useCallback(async () => {
    if (!checkoutSession || checkoutCallId == null) return;

    setIsCanceling(true);
    setErrorMessage(null);

    if (onCallTool) {
      try {
        const result = await onCallTool("cancel_checkout", {
          checkout_session_id: checkoutSession.id,
        });

        const resultObj = result as Record<string, unknown> | null;
        if (resultObj?.isError || resultObj?.error) {
          const errorMsg =
            typeof resultObj.error === "string"
              ? resultObj.error
              : "Failed to cancel checkout";
          setErrorMessage(errorMsg);
          setIsCanceling(false);
          return;
        }

        // Cancel succeeded - respond to widget
        onRespond({ error: "Checkout canceled" });
        resetForm();
        onOpenChange(false);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Cancel failed";
        setErrorMessage(errMsg);
        setIsCanceling(false);
      }
    } else {
      // No onCallTool - just close
      onRespond({ error: "Checkout canceled" });
      resetForm();
      onOpenChange(false);
    }
  }, [checkoutSession, checkoutCallId, onCallTool, onRespond, resetForm, onOpenChange]);

  // Handle update checkout via MCP tool (e.g., when fulfillment changes)
  const handleUpdateCheckout = useCallback(
    async (updates: {
      fulfillment_option_id?: string;
      items?: Array<{ id: string; quantity: number }>;
    }) => {
      if (!checkoutSession || !onCallTool) return false;

      setIsUpdating(true);
      setErrorMessage(null);

      try {
        const result = await onCallTool("update_checkout", {
          checkout_session_id: checkoutSession.id,
          ...updates,
        });

        const resultObj = result as Record<string, unknown> | null;
        if (resultObj?.isError || resultObj?.error) {
          const errorMsg =
            typeof resultObj.error === "string"
              ? resultObj.error
              : "Failed to update checkout";
          setErrorMessage(errorMsg);
          setIsUpdating(false);
          return false;
        }

        // Check if we got an updated session back
        const updatedSession =
          (resultObj?.structuredContent as Record<string, unknown>)
            ?.checkout_session || resultObj?.checkout_session;

        if (updatedSession) {
          setCheckoutSession(updatedSession as CheckoutSession);
        }

        setIsUpdating(false);
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Update failed";
        setErrorMessage(errMsg);
        setIsUpdating(false);
        return false;
      }
    },
    [checkoutSession, onCallTool]
  );

  // Reset form when checkout session changes
  useEffect(() => {
    if (checkoutSession?.id) {
      resetForm();
      setSelectedFulfillmentId(checkoutSession.fulfillment_option_id ?? null);
    }
  }, [checkoutSession?.id, resetForm]);

  const handleClose = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        if (
          checkoutCallId != null &&
          (step === "review" || step === "payment" || step === "fulfillment")
        ) {
          onRespond({ error: "Checkout canceled" });
        }
        resetForm();
      }
      onOpenChange(newOpen);
    },
    [checkoutCallId, step, onRespond, onOpenChange, resetForm]
  );

  // Determine if we need fulfillment selection
  const needsFulfillmentSelection = useMemo(() => {
    if (!checkoutSession) return false;
    const options = checkoutSession.fulfillment_options;
    if (!options || options.length === 0) return false;
    // If there's only one option and it's already selected, skip
    if (options.length === 1 && checkoutSession.fulfillment_option_id)
      return false;
    // If multiple options and none selected, need selection
    if (options.length > 1 && !selectedFulfillmentId) return true;
    return false;
  }, [checkoutSession, selectedFulfillmentId]);

  // Calculate totals based on selected fulfillment
  const calculatedTotals = useMemo(() => {
    if (!checkoutSession) return null;

    const baseTotals = [...(checkoutSession.totals || [])];

    // If we have a selected fulfillment option, update the fulfillment cost
    if (selectedFulfillmentId && checkoutSession.fulfillment_options) {
      const selectedOption = checkoutSession.fulfillment_options.find(
        (o) => o.id === selectedFulfillmentId
      );
      if (selectedOption) {
        // Update fulfillment total
        const fulfillmentIdx = baseTotals.findIndex(
          (t) => t.type === "fulfillment"
        );
        if (fulfillmentIdx >= 0) {
          baseTotals[fulfillmentIdx] = {
            ...baseTotals[fulfillmentIdx],
            amount: selectedOption.total,
          };
        }

        // Recalculate grand total
        const totalIdx = baseTotals.findIndex((t) => t.type === "total");
        if (totalIdx >= 0) {
          const nonTotalSum = baseTotals
            .filter((t) => t.type !== "total" && t.type !== "items_discount" && t.type !== "discount")
            .reduce((sum, t) => sum + t.amount, 0);
          const discountSum = baseTotals
            .filter((t) => t.type === "items_discount" || t.type === "discount")
            .reduce((sum, t) => sum + t.amount, 0);
          baseTotals[totalIdx] = {
            ...baseTotals[totalIdx],
            amount: nonTotalSum - discountSum,
          };
        }
      }
    }

    return baseTotals;
  }, [checkoutSession, selectedFulfillmentId]);

  const grandTotal = useMemo(() => {
    return calculatedTotals?.find((t) => t.type === "total")?.amount ?? 0;
  }, [calculatedTotals]);

  const handleProceedToPayment = useCallback(() => {
    if (needsFulfillmentSelection && !selectedFulfillmentId) {
      setStep("fulfillment");
    } else {
      setStep("payment");
    }
  }, [needsFulfillmentSelection, selectedFulfillmentId]);

  const handleFulfillmentSelected = useCallback(async () => {
    if (!selectedFulfillmentId) {
      setErrorMessage("Please select a shipping method");
      return;
    }
    setErrorMessage(null);

    // If onCallTool is available, call update_checkout to persist the selection
    if (onCallTool && checkoutSession) {
      const success = await handleUpdateCheckout({
        fulfillment_option_id: selectedFulfillmentId,
      });
      if (!success) {
        // Error message already set by handleUpdateCheckout
        return;
      }
    }

    setStep("payment");
  }, [selectedFulfillmentId, onCallTool, checkoutSession, handleUpdateCheckout]);

  const handleQuickFill = useCallback((cardNum: string) => {
    setCardNumber(formatCardNumber(cardNum));
    setExpiry("12/29");
    setCvc("123");
    if (!cardholderName) setCardholderName("Test User");
  }, [cardholderName]);

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
    setErrorCode(null);
    setStep("processing");

    // Handle infrastructure error scenarios first (these override card behavior)
    if (errorScenario !== "none") {
      if (errorScenario === "network_timeout") {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        setErrorMessage("Network timeout: Request timed out after 10 seconds");
        setStep("error");
        return;
      }
      if (errorScenario === "server_error") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        setErrorMessage("Server error (500): Internal server error occurred");
        setStep("error");
        return;
      }
      if (errorScenario === "slow_response") {
        // Add extra 5s delay but continue with normal flow
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

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
      billing_address: hasBillingAddress ? (billingAddress as Address) : undefined,
    };

    // Check test card behavior
    const testCardBehavior = getTestCardBehavior(rawCardNumber);

    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Check if we should simulate failure based on test card
    const shouldFail =
      testCardBehavior?.behavior === "decline" ||
      testCardBehavior?.behavior === "insufficient_funds" ||
      testCardBehavior?.behavior === "expired" ||
      testCardBehavior?.behavior === "processing_error" ||
      testCardBehavior?.behavior === "3ds";

    if (shouldFail && testCardBehavior) {
      const errCode = testCardBehavior.errorCode ?? null;
      const errMsg = testCardBehavior.errorMessage ?? "Payment failed.";

      setErrorCode(errCode);
      setErrorMessage(errMsg);
      setStep("error");
      return;
    }

    // If onCallTool is provided, call the complete_checkout MCP tool
    if (onCallTool) {
      try {
        const result = await onCallTool("complete_checkout", {
          checkout_session_id: checkoutSession.id,
          buyer,
          payment_data: paymentData,
          fulfillment_option_id: selectedFulfillmentId,
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
          setCompletedOrder(
            resultObj as unknown as CompleteCheckoutSessionResponse
          );
          setStep("success");
          return;
        }

        // Fallback: simulate success if tool returned something
        setCompletedOrder({
          checkout_session: {
            ...checkoutSession,
            status: "completed",
            buyer,
            fulfillment_option_id: selectedFulfillmentId ?? undefined,
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
      // No onCallTool - simulate success
      setCompletedOrder({
        checkout_session: {
          ...checkoutSession,
          status: "completed",
          buyer,
          fulfillment_option_id: selectedFulfillmentId ?? undefined,
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
    selectedFulfillmentId,
    errorScenario,
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
    setErrorCode(null);
    setStep("payment");
  }, []);

  const handleSimulateFailure = useCallback(() => {
    if (checkoutCallId == null) return;
    onRespond({ error: "Simulated checkout failure" });
    resetForm();
    onOpenChange(false);
  }, [checkoutCallId, onRespond, resetForm, onOpenChange]);

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>
                {step === "review" && "Review Order"}
                {step === "fulfillment" && "Select Shipping"}
                {step === "payment" && "Payment"}
                {step === "processing" && "Processing Payment"}
                {step === "success" && "Order Complete"}
                {step === "error" && "Payment Failed"}
              </span>
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
                    {/* Messages */}
                    {(checkoutSession.messages?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        {checkoutSession.messages.map((msg, idx) => (
                          <MessageDisplay key={idx} message={msg} />
                        ))}
                      </div>
                    )}

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
                                <div className="flex items-start gap-3 min-w-0">
                                  {item.image_url && (
                                    <img
                                      src={item.image_url}
                                      alt={item.title}
                                      className="w-12 h-12 rounded object-cover"
                                    />
                                  )}
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
                                </div>
                                <div className="text-right tabular-nums shrink-0">
                                  <div className="font-medium">
                                    {formatMinorAmount(
                                      item.total ?? item.subtotal ?? 0,
                                      checkoutSession.currency
                                    )}
                                  </div>
                                  {typeof item.discount === "number" &&
                                    item.discount > 0 && (
                                      <div className="text-xs text-green-600">
                                        -
                                        {formatMinorAmount(
                                          item.discount,
                                          checkoutSession.currency
                                        )}
                                      </div>
                                    )}
                                  {typeof item.tax === "number" && item.tax > 0 && (
                                    <div className="text-xs text-muted-foreground">
                                      Tax:{" "}
                                      {formatMinorAmount(
                                        item.tax,
                                        checkoutSession.currency
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

                    {/* Fulfillment Options Preview */}
                    {checkoutSession.fulfillment_options?.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium flex items-center gap-2">
                          <Package className="h-3 w-3" />
                          Fulfillment
                        </div>
                        {checkoutSession.fulfillment_option_id ? (
                          <div className="text-xs text-muted-foreground">
                            {checkoutSession.fulfillment_options.find(
                              (o) =>
                                o.id === checkoutSession.fulfillment_option_id
                            )?.title || "Selected"}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {checkoutSession.fulfillment_options.length}{" "}
                            option(s) available
                          </div>
                        )}
                      </div>
                    )}

                    {/* Totals */}
                    <div className="space-y-2">
                      <div className="text-xs font-medium">Summary</div>
                      {calculatedTotals?.length ? (
                        <div className="rounded-md border border-border/50">
                          {calculatedTotals.map((t, idx) => (
                            <div
                              key={`${t.type}-${idx}`}
                              className={`flex items-center justify-between gap-2 px-3 py-2 border-b last:border-b-0 border-border/50 ${
                                t.type === "total" ? "font-medium" : ""
                              } ${
                                t.type === "items_discount" || t.type === "discount"
                                  ? "text-green-600"
                                  : ""
                              }`}
                            >
                              <div className="text-muted-foreground">
                                {t.display_text || t.type}
                              </div>
                              <div className="tabular-nums">
                                {t.type === "items_discount" || t.type === "discount"
                                  ? `-${formatMinorAmount(t.amount, checkoutSession.currency)}`
                                  : formatMinorAmount(t.amount, checkoutSession.currency)}
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

                    {/* Payment mode indicator */}
                    {checkoutSession.payment_mode === "test" && (
                      <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
                        Test mode: Use card 4242 4242 4242 4242 for success
                      </div>
                    )}

                    {/* Provider badge */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CreditCard className="h-3 w-3" />
                      Powered by{" "}
                      {checkoutSession.payment_provider?.provider || "Stripe"}
                    </div>
                  </div>
                )}
              </ScrollArea>

              <div className="flex items-center justify-between gap-2 pt-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelCheckout}
                    disabled={
                      checkoutSession == null ||
                      checkoutCallId == null ||
                      isCanceling
                    }
                    className="text-xs"
                  >
                    {isCanceling ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        Canceling...
                      </>
                    ) : (
                      <>
                        <X className="h-3 w-3 mr-1" />
                        Cancel
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSimulateFailure}
                    disabled={checkoutSession == null || checkoutCallId == null}
                    className="text-xs text-muted-foreground"
                  >
                    Simulate Failure
                  </Button>
                </div>
                <Button
                  onClick={handleProceedToPayment}
                  disabled={
                    checkoutSession == null ||
                    checkoutCallId == null ||
                    checkoutSession.status === "not_ready_for_payment" ||
                    isCanceling ||
                    isUpdating
                  }
                >
                  {needsFulfillmentSelection
                    ? "Select Shipping"
                    : "Proceed to Payment"}
                </Button>
              </div>
            </>
          )}

          {/* Step: Fulfillment Selection */}
          {step === "fulfillment" && checkoutSession && (
            <>
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-sm font-medium">
                    Choose your shipping method
                  </div>
                  <RadioGroup
                    value={selectedFulfillmentId ?? ""}
                    onValueChange={setSelectedFulfillmentId}
                    className="space-y-2"
                  >
                    {checkoutSession.fulfillment_options?.map((option) => (
                      <FulfillmentOptionCard
                        key={option.id}
                        option={option}
                        selected={selectedFulfillmentId === option.id}
                        onSelect={() => setSelectedFulfillmentId(option.id)}
                        currency={checkoutSession.currency}
                      />
                    ))}
                  </RadioGroup>
                </div>

                {errorMessage && (
                  <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    {errorMessage}
                  </div>
                )}

                {/* Updated totals */}
                <div className="flex items-center justify-between text-sm font-medium pt-2 border-t">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatMinorAmount(grandTotal, checkoutSession.currency)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-2">
                <Button variant="outline" onClick={() => setStep("review")} disabled={isUpdating}>
                  Back
                </Button>
                <Button onClick={handleFulfillmentSelected} disabled={isUpdating}>
                  {isUpdating ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Updating...
                    </>
                  ) : (
                    "Continue to Payment"
                  )}
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

                {/* Quick-fill test cards */}
                <div className="rounded-md bg-muted/50 px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Quick fill:</span>
                    <div className="flex flex-wrap gap-1">
                      {QUICK_FILL_CARDS.map((card) => (
                        <button
                          key={card.key}
                          type="button"
                          onClick={() => handleQuickFill(card.number)}
                          title={card.title}
                          className={`px-2 py-0.5 text-xs rounded border transition-colors cursor-pointer ${
                            cardNumber.replace(/\s/g, "") === card.number
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background border-border hover:border-primary/50"
                          }`}
                        >
                          {card.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Simulate:</span>
                    <select
                      value={errorScenario}
                      onChange={(e) => setErrorScenario(e.target.value as ErrorScenario)}
                      className="text-xs px-2 py-0.5 rounded border border-border bg-background cursor-pointer"
                    >
                      {(Object.entries(ERROR_SCENARIOS) as [ErrorScenario, { label: string; description: string }][]).map(
                        ([key, { label, description }]) => (
                          <option key={key} value={key} title={description}>
                            {label}
                          </option>
                        )
                      )}
                    </select>
                  </div>
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
                <Button
                  variant="outline"
                  onClick={() =>
                    setStep(needsFulfillmentSelection ? "fulfillment" : "review")
                  }
                >
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
                {errorCode && (
                  <Badge
                    variant="outline"
                    className="text-xs bg-destructive/10 border-destructive/30"
                  >
                    {errorCode}
                  </Badge>
                )}
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
    </>
  );
}
