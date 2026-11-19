/** What a `resources/read` of an MCP Apps UI resource must contain. */

import { Buffer } from "node:buffer";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeHtmlPayload(content: Record<string, unknown>): {
  hasText: boolean;
  hasBlob: boolean;
  html: string;
} {
  const text = typeof content.text === "string" ? content.text : undefined;
  const blob = typeof content.blob === "string" ? content.blob : undefined;

  if (text !== undefined) {
    return {
      hasText: true,
      hasBlob: false,
      html: text,
    };
  }

  if (blob !== undefined) {
    return {
      hasText: false,
      hasBlob: true,
      html: Buffer.from(blob, "base64").toString("utf8"),
    };
  }

  return {
    hasText: false,
    hasBlob: false,
    html: "",
  };
}

export function looksLikeHtmlDocument(html: string): boolean {
  const normalized = html.trim().toLowerCase();
  return (
    normalized.startsWith("<!doctype html") ||
    normalized.includes("<html")
  );
}

export function validateUiMeta(
  meta: unknown,
  uri: string,
  contentIndex: number,
): string[] {
  if (meta === undefined) {
    return [];
  }

  if (!isPlainObject(meta)) {
    return [`${uri} contents[${contentIndex}] _meta must be an object`];
  }

  const ui = meta.ui;
  if (ui === undefined) {
    return [];
  }

  if (!isPlainObject(ui)) {
    return [`${uri} contents[${contentIndex}] _meta.ui must be an object`];
  }

  const violations: string[] = [];
  const csp = ui.csp;
  if (csp !== undefined) {
    if (!isPlainObject(csp)) {
      violations.push(`${uri} contents[${contentIndex}] _meta.ui.csp must be an object`);
    } else {
      for (const key of [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
      ] as const) {
        const value = csp[key];
        if (
          value !== undefined &&
          (!Array.isArray(value) ||
            value.some((entry) => typeof entry !== "string" || entry.trim().length === 0))
        ) {
          violations.push(
            `${uri} contents[${contentIndex}] _meta.ui.csp.${key} must be an array of non-empty strings`,
          );
        }
      }
    }
  }

  const permissions = ui.permissions;
  if (permissions !== undefined) {
    if (!isPlainObject(permissions)) {
      violations.push(
        `${uri} contents[${contentIndex}] _meta.ui.permissions must be an object`,
      );
    } else {
      const allowedPermissions = new Set([
        "camera",
        "microphone",
        "geolocation",
        "clipboardWrite",
      ]);
      for (const [key, value] of Object.entries(permissions)) {
        if (!allowedPermissions.has(key)) {
          violations.push(
            `${uri} contents[${contentIndex}] _meta.ui.permissions.${key} is not a recognized permission`,
          );
          continue;
        }
        if (!isPlainObject(value)) {
          violations.push(
            `${uri} contents[${contentIndex}] _meta.ui.permissions.${key} must be an object`,
          );
        }
      }
    }
  }

  if (ui.domain !== undefined) {
    if (typeof ui.domain !== "string" || ui.domain.trim().length === 0) {
      violations.push(
        `${uri} contents[${contentIndex}] _meta.ui.domain must be a non-empty string`,
      );
    }
  }

  if (
    ui.prefersBorder !== undefined &&
    typeof ui.prefersBorder !== "boolean"
  ) {
    violations.push(
      `${uri} contents[${contentIndex}] _meta.ui.prefersBorder must be a boolean`,
    );
  }

  return violations;
}
