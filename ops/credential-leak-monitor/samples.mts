/**
 * Sample URLs built from the credential-URL registry: one unredacted URL per
 * route (in every form the monitor reads it in), plus values that must NOT
 * be flagged. The unit test and `run.mts --self-test` both use them, so the
 * JavaScript and the RE2 (HogQL) readings of the patterns are checked
 * against the same corpus.
 */
import {
  CREDENTIAL_ROUTES,
  type CredentialRoute,
} from "../../mcpjam-inspector/shared/credential-urls.ts";
import { GENERIC_SECRET_PARAM_ID, USERINFO_ID } from "./patterns.mts";

/** Looks like a real token; matches no reserved word. */
export const SAMPLE_SECRET = "Zx9SecretValue_0123456789abcdef";

export interface LeakSample {
  /** The value as a telemetry property would carry it. */
  value: string;
  /** Route id the monitor must attribute it to; `null` = must not flag. */
  expected: string | null;
  /** Whether `value` is a URL (scrub with `scrubCredentialUrl`) or text. */
  kind: "url" | "text";
}

const HOST = "https://app.mcpjam.com";

/** A concrete path for a template, with the secret segment set to `secret`. */
function concretePath(route: CredentialRoute, secret: string): string {
  const splat = route.pattern.endsWith("*");
  const body = splat ? route.pattern.slice(0, -1) : route.pattern;
  const path = body
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      return segment.slice(1) === route.secretParam ? secret : "slug-1";
    })
    .join("/");
  if (!splat) return path;
  // `/*` → a page; `/api/*` → an endpoint; `/oauth/callback*` → as is.
  if (path === "/") return "/some/page";
  return path.endsWith("/") ? `${path}stream` : path;
}

/** The registry's sample URLs, one group per route, in every form. */
export function routeSamples(): LeakSample[] {
  const samples: LeakSample[] = [];
  for (const route of CREDENTIAL_ROUTES as readonly CredentialRoute[]) {
    if (route.secretIn === "path") {
      const path = concretePath(route, SAMPLE_SECRET);
      samples.push(
        { value: `${HOST}${path}`, expected: route.id, kind: "url" },
        {
          value: `${HOST}${path}?tab=overview`,
          expected: route.id,
          kind: "url",
        },
        { value: path, expected: route.id, kind: "url" },
        { value: `${HOST}/#${path}`, expected: route.id, kind: "url" },
        {
          value: `a:attr__href="${path}"href="${path}"nth-child="1"`,
          expected: route.id,
          kind: "text",
        },
      );
      for (const reserved of route.reserved ?? []) {
        samples.push({
          value: `${HOST}${concretePath(route, reserved)}`,
          expected: null,
          kind: "url",
        });
      }
      continue;
    }
    const path = concretePath(route, "");
    const mark = route.secretIn === "query" ? "?" : "#";
    samples.push(
      {
        value: `${HOST}${path}${mark}${route.secretParam}=${SAMPLE_SECRET}`,
        expected: route.id,
        kind: "url",
      },
      {
        value: `${path}${mark}from=menu&${route.secretParam}=${SAMPLE_SECRET}`,
        expected: route.id,
        kind: "url",
      },
    );
  }
  return samples;
}

/** Shapes that are not one route: any secret key, presigned URLs, userinfo. */
export function genericSamples(): LeakSample[] {
  return [
    {
      value: `https://idp.example.com/authorize?client_id=abc&client_secret=${SAMPLE_SECRET}`,
      expected: GENERIC_SECRET_PARAM_ID,
      kind: "url",
    },
    {
      value: `https://bucket.s3.amazonaws.com/f.png?X-Amz-Signature=${SAMPLE_SECRET}`,
      expected: GENERIC_SECRET_PARAM_ID,
      kind: "url",
    },
    {
      value: `https://example.com/page?x_vendor_access_token=${SAMPLE_SECRET}`,
      expected: GENERIC_SECRET_PARAM_ID,
      kind: "url",
    },
    {
      value: `https://example.com#access_token=${SAMPLE_SECRET}`,
      expected: GENERIC_SECRET_PARAM_ID,
      kind: "url",
    },
    {
      value: `https://user:${SAMPLE_SECRET}@example.com/repo.git`,
      expected: USERINFO_ID,
      kind: "url",
    },
  ];
}

/** Values the monitor must never flag. */
export function cleanSamples(): LeakSample[] {
  return [
    "$direct",
    "",
    `${HOST}/p/k57abc/servers?tab=tools`,
    `${HOST}/results/[redacted]`,
    "/results/%5Bredacted%5D",
    "/results/:runToken",
    "/user-testing/:slug/:token",
    "/bench/results/<secret>",
    `${HOST}/oauth/callback?code=[redacted]&state=[redacted]`,
    "/api/mcp/stream?_token=[redacted]",
    `${HOST}/some/page?tab=1&format=json&sort=asc`,
    `${HOST}/some/page?tokenizer=bpe&keys=2`,
    "https://example.com/repo.git",
    `a:attr__href="/results/[redacted]"nth-child="1"`,
  ].map((value) => ({ value, expected: null, kind: "url" as const }));
}

export function allSamples(): LeakSample[] {
  return [...routeSamples(), ...genericSamples(), ...cleanSamples()];
}
