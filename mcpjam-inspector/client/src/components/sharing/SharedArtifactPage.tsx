import type { ReactNode } from "react";

export const SHARE_LINK_DENIED_MESSAGE =
  "This share link is invalid or has been revoked.";

/**
 * Chrome-less shell for redeemed artifact viewers. All denials collapse
 * to {@link SHARE_LINK_DENIED_MESSAGE}. Token stripping and fetch live
 * in `useSharedArtifact` (I2).
 */
export function SharedArtifactPage({
  title,
  loading,
  error,
  children,
}: {
  title: string;
  loading?: boolean;
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <meta name="robots" content="noindex, nofollow" />
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : null}
        {error ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {SHARE_LINK_DENIED_MESSAGE}
          </p>
        ) : null}
        {!loading && !error ? children : null}
      </div>
    </div>
  );
}
