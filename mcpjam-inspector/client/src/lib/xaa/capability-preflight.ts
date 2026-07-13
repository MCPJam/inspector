// AS-compatibility preflight moved to @mcpjam/sdk (browser-safe). Re-exported
// here so existing `@/lib/xaa/capability-preflight` importers keep their path.
export {
  detectVendor,
  analyzeAsCompatibility,
  JWT_BEARER_GRANT,
} from "@mcpjam/sdk/browser";
export type {
  XAAVendor,
  XAAVendorVerdict,
  XAAVendorHint,
  XAACheckStatus,
  XAACompatibilityCheck,
  XAACompatibilityVerdict,
  XAACompatibilityReport,
} from "@mcpjam/sdk/browser";
