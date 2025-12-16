/**
 * Types for OpenAI Agentic Checkout Protocol (ACP)
 * Based on: https://developers.openai.com/commerce/specs/checkout#object-definitions
 */

// ============================================================================
// Request Types
// ============================================================================

export type Buyer = {
  email?: string;
  name?: string;
  phone?: string;
};

export type Item = {
  id: string;
  quantity: number;
};

export type Address = {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postal_code: string;
  country: string;
};

// ============================================================================
// Checkout Session Types
// ============================================================================

export type CheckoutSessionStatus =
  | "not_ready_for_payment"
  | "ready_for_payment"
  | "completed"
  | "canceled"
  | "in_progress";

export type PaymentProvider = {
  provider: "stripe" | "adyen";
  supported_payment_methods: string[];
};

export type LineItem = {
  id: string;
  title: string;
  subtitle?: string;
  image_url?: string;
  quantity: number;
  base_amount: number; // Integer in minor units
  discount: number; // Integer in minor units, >= 0
  subtotal: number; // Integer in minor units, >= 0
  tax: number; // Integer in minor units, >= 0
  total: number; // Integer in minor units, >= 0
};

export type TotalType =
  | "items_base_amount"
  | "items_discount"
  | "subtotal"
  | "discount"
  | "fulfillment"
  | "tax"
  | "fee"
  | "total";

export type Total = {
  type: TotalType;
  display_text: string;
  amount: number; // Integer in minor units, >= 0
};

export type FulfillmentOptionShipping = {
  type: "shipping";
  id: string;
  title: string;
  subtitle: string;
  carrier_info: string;
  earliest_delivery_time: string; // RFC 3339 string
  latest_delivery_time: string; // RFC 3339 string
  subtotal: number; // Integer in minor units, >= 0
  tax: number; // Integer in minor units, >= 0
  total: number; // Integer in minor units, >= 0
};

export type FulfillmentOptionDigital = {
  type: "digital";
  id: string;
  title: string;
  subtitle?: string;
  subtotal: number; // Integer in minor units, >= 0
  tax: number; // Integer in minor units, >= 0
  total: number; // Integer in minor units, >= 0
};

export type FulfillmentOption =
  | FulfillmentOptionShipping
  | FulfillmentOptionDigital;

export type Message = {
  type: "info" | "error" | "warning";
  text: string;
};

export type Link = {
  type: "terms_of_service" | "privacy_policy" | "refund_policy" | "other";
  text: string;
  url: string;
};

export type CheckoutSession = {
  id: string;
  buyer?: Buyer;
  payment_provider: PaymentProvider;
  status: CheckoutSessionStatus;
  currency: string; // ISO 4217 standard, lowercase
  line_items: LineItem[];
  fulfillment_address?: Address;
  fulfillment_options: FulfillmentOption[];
  fulfillment_option_id?: string;
  totals: Total[];
  messages: Message[];
  links: Link[];
};

// ============================================================================
// Checkout Session Request Types
// ============================================================================

export type CreateCheckoutSessionRequest = {
  buyer?: Buyer;
  items: Item[]; // Non-empty list
  fulfillment_address?: Address;
};

export type UpdateCheckoutSessionRequest = {
  buyer?: Buyer;
  items?: Item[];
  fulfillment_address?: Address;
  fulfillment_option_id?: string;
  discount_code?: string;
};

export type CompleteCheckoutSessionRequest = {
  payment_data: PaymentData;
};

// ============================================================================
// Payment Types
// ============================================================================

export type PaymentData = {
  token: string;
  provider: "stripe" | "adyen";
  billing_address?: Address;
};

// ============================================================================
// Order Types
// ============================================================================

export type OrderStatus =
  | "created"
  | "manual_review"
  | "confirmed"
  | "canceled"
  | "shipped"
  | "fulfilled";

export type Order = {
  id: string;
  checkout_session_id: string;
  permalink_url: string;
};

export type CompleteCheckoutSessionResponse = {
  checkout_session: CheckoutSession;
  order: Order;
};

// ============================================================================
// Webhook Types
// ============================================================================

export type WebhookEventType = "order_created" | "order_updated";

export type RefundType = "store_credit" | "original_payment";

export type Refund = {
  type: RefundType;
  amount: number; // Integer in minor units, >= 0
};

export type EventData = {
  type: "order";
  checkout_session_id: string;
  permalink_url: string;
  status: OrderStatus;
  refunds: Refund[];
};

export type WebhookEvent = {
  type: WebhookEventType;
  data: EventData;
};

// ============================================================================
// Request/Response Headers Types
// ============================================================================

export type CheckoutRequestHeaders = {
  authorization: string; // Bearer api_key_123
  "accept-language"?: string; // e.g., "en-US"
  "user-agent"?: string;
  "idempotency-key": string;
  "request-id": string;
  "content-type": "application/json";
  signature: string; // Base64 encoded signature
  timestamp: string; // RFC 3339 string
  "api-version": string; // e.g., "2025-09-12"
};

export type CheckoutResponseHeaders = {
  "idempotency-key": string;
  "request-id": string;
};
