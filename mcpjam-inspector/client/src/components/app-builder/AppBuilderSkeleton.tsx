/**
 * Lightweight loading shell for App Builder while auth or first-run connect settles.
 * Sidebars are collapsed during onboarding so no skeleton is needed.
 */
export function AppBuilderSkeleton() {
  return <div className="h-full bg-background" />;
}
