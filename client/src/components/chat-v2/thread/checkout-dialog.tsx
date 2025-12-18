import { useState, useCallback, useEffect, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { formatMinorAmount } from "@/lib/currency";
import {
  Loader2,
  CreditCard,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Truck,
  Zap,
} from "lucide-react";
import type {
  CheckoutSession,
  Buyer,
  PaymentData,
  Address,
  CompleteCheckoutSessionResponse,
  FulfillmentOption,
} from "@/shared/acp-types";

// ============================================================================
// Test Card Definitions (for simulating payment scenarios)
// ============================================================================

type PaymentErrorCode =
  | "payment_declined"
  | "requires_3ds"
  | "processing_error";

interface TestCardBehavior {
  behavior:
    | "success"
    | "decline"
    | "insufficient_funds"
    | "expired"
    | "3ds"
    | "processing_error";
  errorCode?: PaymentErrorCode;
  errorMessage?: string;
}

const TEST_CARDS: Record<
  string,
  { number: string; behavior: TestCardBehavior }
> = {
  success: { number: "4242424242424242", behavior: { behavior: "success" } },
  decline_generic: {
    number: "4000000000000002",
    behavior: {
      behavior: "decline",
      errorCode: "payment_declined",
      errorMessage: "Your card was declined.",
    },
  },
  decline_insufficient: {
    number: "4000000000009995",
    behavior: {
      behavior: "insufficient_funds",
      errorCode: "payment_declined",
      errorMessage: "Insufficient funds.",
    },
  },
  decline_expired: {
    number: "4000000000000069",
    behavior: {
      behavior: "expired",
      errorCode: "payment_declined",
      errorMessage: "Card has expired.",
    },
  },
  requires_3ds: {
    number: "4000000000003155",
    behavior: {
      behavior: "3ds",
      errorCode: "requires_3ds",
      errorMessage: "3D Secure required.",
    },
  },
  processing_error: {
    number: "4000000000000119",
    behavior: {
      behavior: "processing_error",
      errorMessage: "Processing error occurred.",
    },
  },
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

type ErrorScenario =
  | "none"
  | "network_timeout"
  | "server_error"
  | "slow_response";

const ERROR_SCENARIOS: Record<
  ErrorScenario,
  { label: string; description: string }
> = {
  none: { label: "Normal", description: "Use card behavior" },
  network_timeout: { label: "Timeout", description: "10s network timeout" },
  server_error: { label: "500 Error", description: "Server error" },
  slow_response: { label: "Slow", description: "5s delay" },
};

// Quick-fill test cards for compact UI
const QUICK_FILL_CARDS = [
  {
    key: "success",
    label: "Success",
    number: TEST_CARDS.success.number,
    icon: "✓",
  },
  {
    key: "decline",
    label: "Decline",
    number: TEST_CARDS.decline_generic.number,
    icon: "✗",
  },
  {
    key: "insufficient",
    label: "Insufficient",
    number: TEST_CARDS.decline_insufficient.number,
    icon: "$",
  },
  {
    key: "3ds",
    label: "3DS",
    number: TEST_CARDS.requires_3ds.number,
    icon: "3D",
  },
  {
    key: "expired",
    label: "Expired",
    number: TEST_CARDS.decline_expired.number,
    icon: "⏱",
  },
  {
    key: "error",
    label: "Error",
    number: TEST_CARDS.processing_error.number,
    icon: "⚠",
  },
] as const;

type CheckoutStep =
  | "payment"
  | "card_entry"
  | "fulfillment"
  | "processing"
  | "success"
  | "error";

interface ServerInfo {
  name: string;
  iconUrl?: string;
}

interface CheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkoutSession: CheckoutSession | null;
  checkoutCallId: number | null;
  onRespond: (payload: { result?: unknown; error?: string }) => void;
  /** Server info to display in header */
  serverInfo?: ServerInfo | null;
  /** Call the complete_checkout MCP tool */
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
    meta?: Record<string, unknown>,
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

// Apple Pay button styled like ChatGPT
function ApplePayButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full h-11 bg-black hover:bg-black/90 disabled:bg-black/50 text-white rounded-full flex items-center justify-center gap-1.5 transition-colors"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
      <span className="font-medium">Pay</span>
    </button>
  );
}

// Google Pay button styled like ChatGPT
function GooglePayButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full h-11 bg-white hover:bg-gray-50 disabled:bg-gray-100 border border-gray-300 rounded-full flex items-center justify-center gap-1.5 transition-colors"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
      <span className="font-medium text-gray-700">Pay</span>
    </button>
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
      className={`rounded-xl border-2 p-4 cursor-pointer transition-all ${
        selected
          ? "border-black bg-gray-50"
          : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`rounded-full p-2 ${
            selected ? "bg-black text-white" : "bg-gray-100"
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
            <span className="font-medium">{option.title}</span>
            <span className="font-medium tabular-nums">
              {option.total === 0
                ? "FREE"
                : formatMinorAmount(option.total, currency)}
            </span>
          </div>
          {option.subtitle && (
            <div className="text-sm text-gray-500 mt-0.5">
              {option.subtitle}
            </div>
          )}
          {isShipping && "carrier_info" in option && (
            <div className="text-sm text-gray-500 mt-1">
              <span>{option.carrier_info}</span>
              {option.earliest_delivery_time && option.latest_delivery_time && (
                <span className="ml-2">
                  Est.{" "}
                  {formatDeliveryWindow(
                    option.earliest_delivery_time,
                    option.latest_delivery_time,
                  )}
                </span>
              )}
            </div>
          )}
        </div>
        <RadioGroupItem value={option.id} checked={selected} className="mt-1" />
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
  serverInfo,
  onCallTool,
}: CheckoutDialogProps) {
  const [step, setStep] = useState<CheckoutStep>("payment");
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
  const [checkoutSession, setCheckoutSession] =
    useState<CheckoutSession | null>(initialSession);
  const [selectedFulfillmentId, setSelectedFulfillmentId] = useState<
    string | null
  >(null);

  const [isUpdating, setIsUpdating] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [errorScenario, setErrorScenario] = useState<ErrorScenario>("none");
  const [showDevTools, setShowDevTools] = useState(false);

  // Saved card state (simulated)
  const [savedCard, setSavedCard] = useState<{
    last4: string;
    brand: string;
  } | null>(null);

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
    setStep("payment");
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
    setSavedCard(null);
    setShowDevTools(false);
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
  }, [
    checkoutSession,
    checkoutCallId,
    onCallTool,
    onRespond,
    resetForm,
    onOpenChange,
  ]);

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
    [checkoutSession, onCallTool],
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
          (step === "payment" ||
            step === "card_entry" ||
            step === "fulfillment")
        ) {
          onRespond({ error: "Checkout canceled" });
        }
        resetForm();
      }
      onOpenChange(newOpen);
    },
    [checkoutCallId, step, onRespond, onOpenChange, resetForm],
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
        (o) => o.id === selectedFulfillmentId,
      );
      if (selectedOption) {
        // Update fulfillment total
        const fulfillmentIdx = baseTotals.findIndex(
          (t) => t.type === "fulfillment",
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
            .filter(
              (t) =>
                t.type !== "total" &&
                t.type !== "items_discount" &&
                t.type !== "discount",
            )
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
        return;
      }
    }

    setStep("payment");
  }, [
    selectedFulfillmentId,
    onCallTool,
    checkoutSession,
    handleUpdateCheckout,
  ]);

  const handleQuickFill = useCallback(
    (cardNum: string) => {
      setCardNumber(formatCardNumber(cardNum));
      setExpiry("12/29");
      setCvc("123");
      if (!cardholderName) setCardholderName("Test User");
    },
    [cardholderName],
  );

  const handleSaveCard = useCallback(() => {
    const rawCardNumber = cardNumber.replace(/\s/g, "");
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

    // Determine card brand
    let brand = "Card";
    if (rawCardNumber.startsWith("4")) brand = "Visa";
    else if (rawCardNumber.startsWith("5")) brand = "Mastercard";
    else if (rawCardNumber.startsWith("3")) brand = "Amex";

    setSavedCard({
      last4: rawCardNumber.slice(-4),
      brand,
    });
    setErrorMessage(null);
    setStep("payment");
  }, [cardNumber, expiry, cvc, cardholderName]);

  const handleProcessPayment = useCallback(async () => {
    if (!checkoutSession || checkoutCallId == null) return;

    // Check if fulfillment selection is needed
    if (needsFulfillmentSelection && !selectedFulfillmentId) {
      setStep("fulfillment");
      return;
    }

    // Need saved card to proceed
    if (!savedCard) {
      setStep("card_entry");
      return;
    }

    const rawCardNumber = cardNumber.replace(/\s/g, "");
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
      billing_address: hasBillingAddress
        ? (billingAddress as Address)
        : undefined,
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
            resultObj as unknown as CompleteCheckoutSessionResponse,
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
    cardholderName,
    email,
    billingAddress,
    onCallTool,
    selectedFulfillmentId,
    errorScenario,
    savedCard,
    needsFulfillmentSelection,
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

  // Get links from session
  const termsLink = checkoutSession?.links?.find(
    (l) => l.type === "terms_of_service",
  );
  const privacyLink = checkoutSession?.links?.find(
    (l) => l.type === "privacy_policy",
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[400px] p-0 gap-0 overflow-hidden rounded-2xl">
        {/* Step: Main Payment View (ChatGPT style) */}
        {step === "payment" && checkoutSession && (
          <div className="flex flex-col">
            {/* Merchant Header */}
            <div className="flex items-center gap-3 p-6 pb-4">
              <span className="text-xl font-semibold">Payment</span>
            </div>

            {/* Payment Method */}
            <div className="px-6 pb-4">
              <button
                onClick={() => setStep("card_entry")}
                className="w-full flex items-center justify-between p-4 rounded-xl border border-gray-200 hover:border-gray-300 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-6 bg-gradient-to-r from-blue-600 to-blue-700 rounded flex items-center justify-center">
                    <span className="text-white text-xs font-bold">
                      {savedCard?.brand === "Visa"
                        ? "VISA"
                        : savedCard?.brand === "Mastercard"
                          ? "MC"
                          : "💳"}
                    </span>
                  </div>
                  {savedCard ? (
                    <span className="text-gray-900">
                      {savedCard.brand} ****{savedCard.last4}
                    </span>
                  ) : (
                    <span className="text-gray-500">Add payment method</span>
                  )}
                </div>
                <ChevronRight className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            {/* Total */}
            <div className="px-6 pb-6">
              <div className="flex items-center justify-between py-3 border-t border-gray-100">
                <span className="text-gray-500">Total</span>
                <span className="text-xl font-semibold tabular-nums">
                  {formatMinorAmount(grandTotal, checkoutSession.currency)}
                </span>
              </div>
            </div>

            {/* Pay Button */}
            <div className="px-6 pb-4">
              <Button
                onClick={handleProcessPayment}
                disabled={!savedCard || isCanceling || isUpdating}
                className="w-full h-12 rounded-full bg-black hover:bg-gray-800 text-white font-medium text-base"
              >
                {isCanceling ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Canceling...
                  </>
                ) : isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Updating...
                  </>
                ) : (
                  `Pay`
                )}
              </Button>
            </div>

            {/* Alternative Payment Methods */}
            <div className="px-6 pb-4 space-y-2">
              <ApplePayButton
                onClick={handleProcessPayment}
                disabled={!savedCard || isCanceling || isUpdating}
              />
              <GooglePayButton
                onClick={handleProcessPayment}
                disabled={!savedCard || isCanceling || isUpdating}
              />
              <button
                onClick={() => setStep("card_entry")}
                className="w-full h-11 border border-gray-200 hover:border-gray-300 rounded-full text-gray-700 font-medium transition-colors"
              >
                Pay with card
              </button>
            </div>

            {/* Dev Tools Toggle */}
            <div className="px-6 pb-2">
              <button
                onClick={() => setShowDevTools(!showDevTools)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                {showDevTools ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                Dev Tools
              </button>
            </div>

            {/* Dev Tools Panel */}
            {showDevTools && (
              <div className="px-6 pb-4 space-y-3">
                <div className="rounded-lg bg-gray-50 p-3 space-y-3">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-600">
                      Quick fill test card:
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {QUICK_FILL_CARDS.map((card) => (
                        <button
                          key={card.key}
                          onClick={() => {
                            handleQuickFill(card.number);
                            // Auto-save the card
                            let brand = "Card";
                            if (card.number.startsWith("4")) brand = "Visa";
                            else if (card.number.startsWith("5"))
                              brand = "Mastercard";
                            setSavedCard({
                              last4: card.number.slice(-4),
                              brand,
                            });
                          }}
                          className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                            savedCard?.last4 === card.number.slice(-4)
                              ? "bg-black text-white border-black"
                              : "bg-white border-gray-200 hover:border-gray-300"
                          }`}
                        >
                          <span className="mr-1">{card.icon}</span>
                          {card.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-600">
                      Simulate error:
                    </div>
                    <select
                      value={errorScenario}
                      onChange={(e) =>
                        setErrorScenario(e.target.value as ErrorScenario)
                      }
                      className="w-full text-xs px-3 py-2 rounded-md border border-gray-200 bg-white"
                    >
                      {(
                        Object.entries(ERROR_SCENARIOS) as [
                          ErrorScenario,
                          { label: string; description: string },
                        ][]
                      ).map(([key, { label, description }]) => (
                        <option key={key} value={key}>
                          {label} - {description}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleCancelCheckout}
                    disabled={isCanceling}
                    className="w-full text-xs py-2 text-red-600 hover:text-red-700 border border-red-200 rounded-md hover:bg-red-50 transition-colors"
                  >
                    {isCanceling ? "Canceling..." : "Cancel Checkout"}
                  </button>
                </div>
              </div>
            )}

            {/* Error Message */}
            {errorMessage && (
              <div className="px-6 pb-4">
                <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {errorMessage}
                </div>
              </div>
            )}

            {/* Footer Disclaimer */}
            <div className="px-6 py-4 bg-gray-50 text-center space-y-2">
              <p className="text-xs text-gray-500">
                By clicking Pay, you agree to the{" "}
                {termsLink ? (
                  <a
                    href={termsLink.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Terms
                  </a>
                ) : (
                  <span className="underline">Terms</span>
                )}{" "}
                and{" "}
                {privacyLink ? (
                  <a
                    href={privacyLink.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Privacy Policy
                  </a>
                ) : (
                  <span className="underline">Privacy Policy</span>
                )}
              </p>
              <p className="text-xs text-gray-400">
                OpenAI does not process your order, collect payment, or handle
                fulfillment.
              </p>
            </div>
          </div>
        )}

        {/* Step: Card Entry */}
        {step === "card_entry" && checkoutSession && (
          <div className="flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 pb-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setStep("payment")}
                  className="p-1 -ml-1 rounded-full hover:bg-gray-100 transition-colors"
                >
                  <ChevronRight className="h-5 w-5 text-gray-900 rotate-180" />
                </button>
                <span className="text-lg font-semibold">
                  Add payment method
                </span>
              </div>
            </div>

            {/* Card Form */}
            <div className="px-6 pb-6 space-y-5">
              {/* Card Section */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                {/* Card header */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
                  <CreditCard className="h-5 w-5 text-gray-600" />
                  <span className="font-medium text-gray-900">Card</span>
                </div>

                {/* Card inputs - connected group */}
                <div className="bg-gray-50/50">
                  {/* Card number row */}
                  <div className="relative border-b border-gray-200">
                    <Input
                      id="cardNumber"
                      placeholder="Card number"
                      value={cardNumber}
                      onChange={(e) =>
                        setCardNumber(formatCardNumber(e.target.value))
                      }
                      className="h-12 pr-36 border-0 rounded-none bg-transparent font-mono text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                      autoComplete="cc-number"
                    />
                    {/* Card brand icons */}
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      <img
                        src="https://js.stripe.com/v3/fingerprinted/img/visa-729c05c240c4bdb47b03ac81d9945bfe.svg"
                        alt="Visa"
                        className="h-6"
                      />
                      <img
                        src="https://js.stripe.com/v3/fingerprinted/img/mastercard-4d8844094130711885b5e41b28c9848f.svg"
                        alt="Mastercard"
                        className="h-6"
                      />
                      <img
                        src="https://js.stripe.com/v3/fingerprinted/img/amex-a49b82f46c5cd6a96a6e418a6ca1717c.svg"
                        alt="Amex"
                        className="h-6"
                      />
                      <img
                        src="https://js.stripe.com/v3/fingerprinted/img/discover-ac52cd46f89fa40a29a0bfb954e33173.svg"
                        alt="Discover"
                        className="h-6"
                      />
                    </div>
                  </div>

                  {/* Expiration and Security code row */}
                  <div className="flex">
                    <div className="flex-1 border-r border-gray-200">
                      <Input
                        id="expiry"
                        placeholder="Expiration date"
                        value={expiry}
                        onChange={(e) =>
                          setExpiry(formatExpiry(e.target.value))
                        }
                        className="h-12 border-0 rounded-none bg-transparent font-mono text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                        autoComplete="cc-exp"
                      />
                    </div>
                    <div className="flex-1 relative">
                      <Input
                        id="cvc"
                        placeholder="Security code"
                        value={cvc}
                        onChange={(e) =>
                          setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))
                        }
                        className="h-12 pr-12 border-0 rounded-none bg-transparent font-mono text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                        autoComplete="cc-csc"
                      />
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <svg
                          viewBox="0 0 32 21"
                          className="h-5 w-8 text-gray-400"
                        >
                          <rect
                            x="0"
                            y="0"
                            width="32"
                            height="21"
                            rx="3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                          <rect
                            x="20"
                            y="4"
                            width="8"
                            height="5"
                            rx="1"
                            fill="currentColor"
                            opacity="0.6"
                          />
                          <text
                            x="21"
                            y="17"
                            fontSize="7"
                            fill="currentColor"
                            fontFamily="monospace"
                          >
                            123
                          </text>
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Billing address section */}
              <div className="space-y-3">
                <div className="font-medium text-gray-900">Billing address</div>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  {/* Full name */}
                  <div className="relative border-b border-gray-200">
                    <label className="absolute left-3 top-2 text-xs text-gray-500">
                      Full name
                    </label>
                    <Input
                      id="cardholderName"
                      placeholder=""
                      value={cardholderName}
                      onChange={(e) => setCardholderName(e.target.value)}
                      className="h-14 pt-5 border-0 rounded-none text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                      autoComplete="cc-name"
                    />
                  </div>
                  {/* Address line 1 */}
                  <div className="relative border-b border-gray-200">
                    <label className="absolute left-3 top-2 text-xs text-gray-500">
                      Address line 1
                    </label>
                    <Input
                      placeholder=""
                      value={billingAddress.line1 || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          line1: e.target.value,
                        }))
                      }
                      className="h-14 pt-5 border-0 rounded-none text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                      autoComplete="address-line1"
                    />
                  </div>
                  {/* Address line 2 */}
                  <div className="relative border-b border-gray-200">
                    <Input
                      placeholder="Address line 2"
                      value={billingAddress.line2 || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          line2: e.target.value,
                        }))
                      }
                      className="h-12 border-0 rounded-none text-base text-gray-500 placeholder:text-gray-400 focus-visible:ring-0 focus-visible:ring-offset-0"
                      autoComplete="address-line2"
                    />
                  </div>
                  {/* City */}
                  <div className="relative border-b border-gray-200">
                    <label className="absolute left-3 top-2 text-xs text-gray-500">
                      City
                    </label>
                    <Input
                      placeholder=""
                      value={billingAddress.city || ""}
                      onChange={(e) =>
                        setBillingAddress((prev) => ({
                          ...prev,
                          city: e.target.value,
                        }))
                      }
                      className="h-14 pt-5 border-0 rounded-none text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                      autoComplete="address-level2"
                    />
                  </div>
                  {/* State + ZIP code row */}
                  <div className="flex border-b border-gray-200">
                    <div className="flex-1 relative border-r border-gray-200">
                      <label className="absolute left-3 top-2 text-xs text-gray-500">
                        State
                      </label>
                      <Input
                        placeholder=""
                        value={billingAddress.state || ""}
                        onChange={(e) =>
                          setBillingAddress((prev) => ({
                            ...prev,
                            state: e.target.value,
                          }))
                        }
                        className="h-14 pt-5 border-0 rounded-none text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                        autoComplete="address-level1"
                      />
                    </div>
                    <div className="flex-1 relative">
                      <label className="absolute left-3 top-2 text-xs text-gray-500">
                        ZIP code
                      </label>
                      <Input
                        placeholder=""
                        value={billingAddress.postal_code || ""}
                        onChange={(e) =>
                          setBillingAddress((prev) => ({
                            ...prev,
                            postal_code: e.target.value,
                          }))
                        }
                        className="h-14 pt-5 border-0 rounded-none text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                        autoComplete="postal-code"
                      />
                    </div>
                  </div>
                  {/* Phone number */}
                  <div className="relative">
                    <label className="absolute left-3 top-2 text-xs text-gray-500">
                      Phone number
                    </label>
                    <div className="flex items-center h-14 pt-3">
                      <div className="flex items-center gap-1 pl-3 pr-2 text-gray-600">
                        <span className="text-sm">🇺🇸</span>
                        <span className="text-sm">+1</span>
                        <ChevronDown className="h-3 w-3" />
                      </div>
                      <Input
                        placeholder=""
                        value={billingAddress.phone || ""}
                        onChange={(e) =>
                          setBillingAddress((prev) => ({
                            ...prev,
                            phone: e.target.value,
                          }))
                        }
                        className="h-10 border-0 rounded-none text-base focus-visible:ring-0 focus-visible:ring-offset-0 pl-0"
                        autoComplete="tel"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Test cards quick fill - dev tools */}
              <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                <div className="text-xs font-medium text-amber-700 mb-2">
                  Quick fill test card:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_FILL_CARDS.slice(0, 4).map((card) => (
                    <button
                      key={card.key}
                      onClick={() => handleQuickFill(card.number)}
                      className="px-2 py-1 text-xs rounded border border-amber-200 bg-white hover:bg-amber-50 transition-colors"
                    >
                      {card.icon} {card.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Error message */}
              {errorMessage && (
                <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {errorMessage}
                </div>
              )}

              <Button
                onClick={handleSaveCard}
                className="w-full h-12 rounded-full bg-black hover:bg-gray-800 text-white font-medium"
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* Step: Fulfillment Selection */}
        {step === "fulfillment" && checkoutSession && (
          <div className="flex flex-col">
            {/* Header */}
            <div className="flex items-center gap-3 p-6 pb-4">
              <button
                onClick={() => setStep("payment")}
                className="p-1.5 -ml-1.5 rounded-full hover:bg-gray-100 transition-colors"
              >
                <ChevronRight className="h-5 w-5 text-gray-500 rotate-180" />
              </button>
              <span className="text-xl font-semibold">Shipping</span>
            </div>

            <div className="px-6 pb-6 space-y-4">
              <RadioGroup
                value={selectedFulfillmentId ?? ""}
                onValueChange={setSelectedFulfillmentId}
                className="space-y-3"
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

              {errorMessage && (
                <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {errorMessage}
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t">
                <span className="text-gray-500">Total</span>
                <span className="text-xl font-semibold tabular-nums">
                  {formatMinorAmount(grandTotal, checkoutSession.currency)}
                </span>
              </div>

              <Button
                onClick={handleFulfillmentSelected}
                disabled={isUpdating || !selectedFulfillmentId}
                className="w-full h-12 rounded-full bg-black hover:bg-gray-800 text-white font-medium"
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Updating...
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Step: Processing */}
        {step === "processing" && (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <Loader2 className="h-10 w-10 animate-spin text-gray-400 mb-4" />
            <div className="text-lg font-medium text-gray-900">
              Processing payment...
            </div>
            <div className="text-sm text-gray-500 mt-1">
              {onCallTool ? "Completing checkout..." : "Please wait..."}
            </div>
          </div>
        )}

        {/* Step: Success */}
        {step === "success" && completedOrder && (
          <div className="flex flex-col items-center justify-center py-12 px-6">
            <div className="rounded-full bg-green-100 p-4 mb-4">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <div className="text-xl font-semibold text-gray-900 mb-1">
              Payment successful
            </div>
            <div className="text-sm text-gray-500 mb-6">
              Order #{completedOrder.order.id.slice(-8)}
            </div>
            <Button
              onClick={handleConfirmSuccess}
              className="w-full h-12 rounded-full bg-black hover:bg-gray-800 text-white font-medium"
            >
              Done
            </Button>
          </div>
        )}

        {/* Step: Error */}
        {step === "error" && (
          <div className="flex flex-col items-center justify-center py-12 px-6">
            <div className="rounded-full bg-red-100 p-4 mb-4">
              <AlertCircle className="h-10 w-10 text-red-600" />
            </div>
            <div className="text-xl font-semibold text-gray-900 mb-1">
              Payment failed
            </div>
            {errorCode && (
              <Badge
                variant="outline"
                className="mb-2 text-xs bg-red-50 border-red-200 text-red-600"
              >
                {errorCode}
              </Badge>
            )}
            <div className="text-sm text-gray-500 text-center mb-6">
              {errorMessage || "An error occurred during payment processing."}
            </div>
            <div className="flex gap-3 w-full">
              <Button
                variant="outline"
                onClick={() => {
                  onRespond({ error: errorMessage || "Payment failed" });
                  resetForm();
                  onOpenChange(false);
                }}
                className="flex-1 h-12 rounded-full"
              >
                Cancel
              </Button>
              <Button
                onClick={handleRetry}
                className="flex-1 h-12 rounded-full bg-black hover:bg-gray-800 text-white"
              >
                Try again
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
