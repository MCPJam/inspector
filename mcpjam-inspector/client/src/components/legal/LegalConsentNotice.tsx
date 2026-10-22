import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from "@/lib/legal-links";

/** Small print under a sign-up or checkout action. */
export function LegalConsentNotice() {
  return (
    <p className="text-xs text-muted-foreground">
      By continuing, you agree to the{" "}
      <LegalLink href={TERMS_OF_USE_URL}>Terms of Use</LegalLink> and
      acknowledge the{" "}
      <LegalLink href={PRIVACY_POLICY_URL}>Privacy Policy</LegalLink>.
    </p>
  );
}

function LegalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-4 hover:text-foreground"
    >
      {children}
    </a>
  );
}
