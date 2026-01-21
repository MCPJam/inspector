/**
 * Re-export model creation utilities from SDK.
 * SDK is the single source of truth for LLM model creation.
 */
export { createModel as createLlmModel, type BaseUrls } from "@/sdk/evals";
