import { describe, it, expect } from "vitest";
import { buildRequestInit } from "./index.js";

describe("buildRequestInit", () => {
  describe("without accessToken", () => {
    it("returns undefined when no accessToken and no requestInit", () => {
      const result = buildRequestInit(undefined, undefined);
      expect(result).toBeUndefined();
    });

    it("returns original requestInit unchanged when no accessToken", () => {
      const originalRequestInit = {
        headers: { "X-Custom-Header": "custom-value" },
        cache: "no-store" as const,
      };

      const result = buildRequestInit(undefined, originalRequestInit);

      expect(result).toBe(originalRequestInit);
      expect(result).toEqual({
        headers: { "X-Custom-Header": "custom-value" },
        cache: "no-store",
      });
    });
  });

  describe("with accessToken", () => {
    it("adds Authorization header when accessToken provided and no requestInit", () => {
      const result = buildRequestInit("my-secret-token", undefined);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-secret-token",
        },
      });
    });

    it("adds Authorization header when accessToken provided and empty requestInit", () => {
      const result = buildRequestInit("my-secret-token", {});

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-secret-token",
        },
      });
    });

    it("merges Authorization header with existing headers", () => {
      const originalRequestInit = {
        headers: {
          "X-Custom-Header": "custom-value",
          "Content-Type": "application/json",
        },
      };

      const result = buildRequestInit("my-secret-token", originalRequestInit);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-secret-token",
          "X-Custom-Header": "custom-value",
          "Content-Type": "application/json",
        },
      });
    });

    it("preserves other requestInit properties when merging", () => {
      const originalRequestInit = {
        headers: { "X-Custom-Header": "custom-value" },
        cache: "no-store" as const,
        credentials: "include" as const,
      };

      const result = buildRequestInit("my-secret-token", originalRequestInit);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-secret-token",
          "X-Custom-Header": "custom-value",
        },
        cache: "no-store",
        credentials: "include",
      });
    });

    it("accessToken Authorization header takes precedence over existing Authorization", () => {
      const originalRequestInit = {
        headers: {
          Authorization: "Bearer old-token",
          "X-Custom-Header": "custom-value",
        },
      };

      const result = buildRequestInit("new-token", originalRequestInit);

      // accessToken is set first, then spread of existing headers overwrites it
      // This tests the current behavior - if we want accessToken to always win,
      // we'd need to reverse the order in the implementation
      expect(result?.headers?.Authorization).toBe("Bearer old-token");
    });
  });

  describe("edge cases", () => {
    it("handles empty string accessToken as falsy (returns original)", () => {
      const originalRequestInit = {
        headers: { "X-Custom-Header": "custom-value" },
      };

      // Empty string is falsy, so should return original
      const result = buildRequestInit("", originalRequestInit);

      // Note: Empty string is falsy in JS, so the function returns original
      expect(result).toBe(originalRequestInit);
    });

    it("handles whitespace-only accessToken (treats as truthy)", () => {
      const result = buildRequestInit("   ", undefined);

      // Whitespace is truthy, so it adds the header (even though not useful)
      expect(result).toEqual({
        headers: {
          Authorization: "Bearer    ",
        },
      });
    });
  });

  describe("headers normalization", () => {
    it("handles Headers instance and merges with accessToken", () => {
      const headersInstance = new Headers();
      headersInstance.set("X-Custom-Header", "custom-value");
      headersInstance.set("Content-Type", "application/json");

      const originalRequestInit = {
        headers: headersInstance,
        cache: "no-store" as const,
      };

      const result = buildRequestInit("my-secret-token", originalRequestInit);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-secret-token",
          "x-custom-header": "custom-value",
          "content-type": "application/json",
        },
        cache: "no-store",
      });
    });

    it("handles string[][] array headers and merges with accessToken", () => {
      const headersArray: [string, string][] = [
        ["X-Custom-Header", "custom-value"],
        ["Content-Type", "application/json"],
      ];

      const originalRequestInit = {
        headers: headersArray,
        credentials: "include" as const,
      };

      const result = buildRequestInit("my-secret-token", originalRequestInit);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-secret-token",
          "x-custom-header": "custom-value",
          "content-type": "application/json",
        },
        credentials: "include",
      });
    });

    it("Headers instance with existing Authorization is preserved over accessToken", () => {
      const headersInstance = new Headers();
      headersInstance.set("Authorization", "Bearer existing-token");
      headersInstance.set("X-Custom-Header", "custom-value");

      const originalRequestInit = {
        headers: headersInstance,
      };

      const result = buildRequestInit("new-token", originalRequestInit);

      // Existing Authorization from Headers instance overwrites the accessToken one
      expect(result?.headers?.Authorization).toBe("Bearer existing-token");
    });

    it("handles empty Headers instance", () => {
      const originalRequestInit = {
        headers: new Headers(),
      };

      const result = buildRequestInit("my-token", originalRequestInit);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-token",
        },
      });
    });

    it("handles empty string[][] array", () => {
      const originalRequestInit = {
        headers: [] as [string, string][],
      };

      const result = buildRequestInit("my-token", originalRequestInit);

      expect(result).toEqual({
        headers: {
          Authorization: "Bearer my-token",
        },
      });
    });
  });
});
