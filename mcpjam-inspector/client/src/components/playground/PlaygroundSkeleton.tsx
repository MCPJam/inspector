/**
 * Lightweight loading shell for the Playground while auth or first-run connect settles.
 * Sidebars are collapsed during onboarding so no skeleton is needed.
 */
export function PlaygroundSkeleton() {
  return <div className="h-full bg-background" />;
}
