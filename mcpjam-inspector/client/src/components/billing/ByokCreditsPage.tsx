export function ByokCreditsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">BYOK and MCPJam credits</h1>
        <p className="text-muted-foreground">
          Your API key and MCPJam credits cover different parts of usage.
        </p>
      </header>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Your key covers model inference</h2>
        <p>
          Bring your own key (BYOK) to pay your model provider directly for
          token inference where BYOK is supported. You manage that provider
          account and its token costs.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">
          MCPJam features still use credits
        </h2>
        <p>
          Unless your organization requires its own keys for all AI features
          (see below), BYOK does not add MCPJam credits or cover usage of Evals,
          Swarm, User Testing, or Insights. You need MCPJam credits separately
          for those features, even when you have configured your own API key.
        </p>
      </section>
      <section className="space-y-2" aria-labelledby="org-keys-billing">
        <h2 id="org-keys-billing" className="text-lg font-medium">
          When your organization uses its keys for all AI features
        </h2>
        <p>
          An organization that turns on “Use your keys for all AI features” runs
          every AI feature on its own providers, including chat, Evals, judges,
          Swarm, User Testing, and Insights. MCPJam-provided models are disabled
          for it. Model tokens are billed by the organization’s providers, not
          paid with MCPJam credits.
        </p>
        <p>
          MCPJam’s fixed product fees and usage limits still apply, so features
          that charge a fixed fee still use credits for that fee.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Need more credits?</h2>
        <p>
          Free credits reset daily. Upgrade to Pro or Team to access more
          credits and purchase credit top-ups. Only an organization owner can
          upgrade; owners and admins on eligible paid plans can buy credits.
        </p>
      </section>
    </div>
  );
}
