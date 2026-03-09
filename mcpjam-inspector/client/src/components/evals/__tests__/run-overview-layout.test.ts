import { describe, expect, it } from "vitest";
import {
  estimateRunsTableRequiredWidth,
  resolveRunsTableLayout,
} from "../run-overview";

describe("resolveRunsTableLayout", () => {
  it("keeps full layout when the container can fit full-width columns", () => {
    const fullWidth = estimateRunsTableRequiredWidth({
      hasTokenData: true,
      hasCiMetadata: true,
      showTokens: true,
      showRunBy: true,
      metadataMode: "full",
    });

    const layout = resolveRunsTableLayout({
      containerWidth: fullWidth,
      hasTokenData: true,
      hasCiMetadata: true,
    });

    expect(layout).toMatchObject({
      showTokens: true,
      showRunBy: true,
      metadataMode: "full",
      enableHorizontalScroll: false,
    });
  });

  it("keeps all columns and enables horizontal scroll when the container is narrow", () => {
    const fullWidth = estimateRunsTableRequiredWidth({
      hasTokenData: true,
      hasCiMetadata: true,
      showTokens: true,
      showRunBy: true,
      metadataMode: "full",
    });

    const layout = resolveRunsTableLayout({
      containerWidth: fullWidth - 1,
      hasTokenData: true,
      hasCiMetadata: true,
    });

    expect(layout).toMatchObject({
      showTokens: true,
      showRunBy: true,
      metadataMode: "full",
      enableHorizontalScroll: true,
    });
  });

  it("keeps run-by and metadata columns even when token column is unavailable", () => {
    const fullNoTokenWidth = estimateRunsTableRequiredWidth({
      hasTokenData: false,
      hasCiMetadata: true,
      showTokens: false,
      showRunBy: true,
      metadataMode: "full",
    });

    const layout = resolveRunsTableLayout({
      containerWidth: fullNoTokenWidth - 1,
      hasTokenData: false,
      hasCiMetadata: true,
    });

    expect(layout).toMatchObject({
      showTokens: false,
      showRunBy: true,
      metadataMode: "full",
      enableHorizontalScroll: true,
    });
  });
});
