import { CheckCircle2, HelpCircle } from "lucide-react";

const registrationMethods = [
  {
    name: "Pre-registered client",
    description:
      "Register MCPJam in your authorization server first, then enter the client ID and optional client secret it gives you.",
  },
  {
    name: "Client metadata URL (CIMD)",
    description:
      "MCPJam uses its hosted client metadata URL as the client ID. Your authorization server must advertise CIMD support.",
  },
  {
    name: "Open dynamic registration (DCR)",
    description:
      "MCPJam registers a client during the test. Your authorization server must provide an open registration endpoint.",
  },
];

const claims = [
  ["iss", "MCPJam's test identity provider"],
  ["sub / email", "The test user's identity"],
  ["aud", "The authorization server receiving the ID-JAG"],
  ["resource", "The MCP server the access is for"],
  ["client_id", "The client identity used in the test"],
  ["jti / iat / exp", "Replay protection and token lifetime"],
  ["scope", "The requested permissions"],
];

const strictNegativeTests = [
  "Bad Signature",
  "Wrong Audience",
  "Expired",
  "Missing Claims",
  "Invalid typ Header",
  "Wrong Issuer",
  "Resource Mismatch",
  "Client ID Mismatch",
  "Unknown kid",
];

const policyProbes = ["Unknown Subject", "Scope Denial"];

function GuideImage({
  src,
  alt,
  className = "",
  imageClassName = "",
}: {
  src: string;
  alt: string;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      title="Open full-size image"
      className={`block overflow-hidden rounded-md ${className}`}
    >
      <img
        src={src}
        alt={alt}
        className={`h-auto w-full object-contain ${imageClassName}`}
      />
    </a>
  );
}

function SectionHeading({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-6 flex gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
        {number}
      </div>
      <div>
        <h3 className="text-xl font-semibold leading-8">{title}</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

export function XAAHowItWorksContent() {
  return (
    <div className="px-6 pb-10 sm:px-10">
      <div className="border-b pb-10 pt-4">
        <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(360px,520px)]">
          <p className="max-w-3xl text-base leading-7 text-muted-foreground">
            The XAA Debugger tests an MCP server and its authorization setup.
            MCPJam acts as both the test identity provider that signs the ID
            token and ID-JAG, and the client/agent that uses them to request
            access.
          </p>
          <img
            src="/xaa-guide/xaa-actors.png"
            alt="XAA flow participants: Agent, IdP, MCP Server, and Authorization Server"
            className="hidden h-16 w-full object-contain object-left lg:block"
          />
        </div>
      </div>

      <section className="border-b py-10">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
          <SectionHeading
            number="1"
            title="Trust MCPJam's identity provider"
            description="Before running the test, give your authorization server the MCPJam identity provider values it requires. You can copy all three from the XAA Flow header."
          />
          <GuideImage
            src="/xaa-guide/xaa-flow-header.png"
            alt="XAA Flow header with issuer, OpenID configuration, and JWKS URLs"
            className="mx-auto max-w-xs"
          />
        </div>

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div>
            <h4 className="font-semibold">Local and hosted issuers</h4>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              If MCPJam is running locally and your authorization server is in
              the cloud, turn on <strong>Use hosted issuer</strong>. A cloud
              server cannot reach an issuer URL on your machine.
            </p>
          </div>
          <GuideImage
            src="/xaa-guide/xaa-hosted-issuer-toggle.png"
            alt="Use hosted issuer toggle"
          />
        </div>
      </section>

      <section className="border-b py-10">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-6">
            <SectionHeading
              number="2"
              title="Add your MCP server"
              description="Select Configure Server to Test, enter the MCP server name and URL, then choose how MCPJam identifies itself to the authorization server."
            />

            <div>
              <h4 className="font-semibold">Registration method</h4>
              <div className="mt-3 divide-y border-y">
                {registrationMethods.map((method) => (
                  <div key={method.name} className="py-4">
                    <p className="text-sm font-medium">{method.name}</p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      {method.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="font-semibold">Scopes</h4>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Enter optional permissions separated by spaces. MCPJam includes
                them when requesting the ID-JAG and access token.
              </p>
            </div>
          </div>
          <GuideImage
            src="/xaa-guide/xaa-configure-server.png"
            alt="Configure Server to Test form"
          />
        </div>

        <div className="mt-10 grid items-start gap-8 lg:grid-cols-[420px_minmax(0,1fr)]">
          <GuideImage
            src="/xaa-guide/xaa-advanced.png"
            alt="Advanced XAA server settings"
          />
          <div>
            <h4 className="font-semibold">Advanced settings</h4>
            <div className="mt-4 space-y-4 text-sm leading-6">
              <div>
                <p className="font-medium text-foreground">
                  Authorization Server Issuer
                </p>
                <p className="mt-1 text-muted-foreground">
                  Leave it blank to use the authorization server MCPJam
                  discovers from the MCP server. Enter a URL to use a different
                  authorization server.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">
                  Issuer mismatch check
                </p>
                <p className="mt-1 text-muted-foreground">
                  Keep <strong>Allow non-standard issuer mismatch</strong> off
                  for normal RFC 8414 behavior. Turn it on only when the
                  discovered URL and metadata issuer differ on the same origin.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">
                  Simulated identity
                </p>
                <p className="mt-1 text-muted-foreground">
                  Choose the user MCPJam puts in the ID token. Leave the fields
                  blank to use your signed-in account.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b py-10">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(520px,620px)]">
          <div>
            <SectionHeading
              number="3"
              title="Inspect the ID-JAG"
              description="Before sending the ID-JAG, MCPJam shows exactly what it created and checks whether each value looks correct or broken."
            />
            <h4 className="font-semibold">What you can inspect</h4>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              The inspector decodes the complete signed assertion before it is
              sent to the authorization server.
            </p>
            <div className="mt-5 divide-y border-y text-sm">
              <div className="py-3">
                <p className="font-medium">Header</p>
                <p className="mt-1 text-muted-foreground">
                  Shows <code>alg</code>, <code>typ</code>, and <code>kid</code>
                  : how the ID-JAG is signed, what kind of token it is, and
                  which published key the authorization server should use.
                </p>
              </div>
              <div className="py-3">
                <p className="font-medium">Payload</p>
                <p className="mt-1 text-muted-foreground">
                  Carries the user, client, authorization-server, and MCP-server
                  bindings listed below.
                </p>
              </div>
              <div className="py-3">
                <p className="font-medium">Signature</p>
                <p className="mt-1 text-muted-foreground">
                  The final signed JWT segment. Use <strong>Copy JWT</strong> to
                  copy the complete assertion, including its header, payload,
                  and signature.
                </p>
              </div>
            </div>
          </div>
          <div>
            <GuideImage
              src="/xaa-guide/xaa-id-jag.png"
              alt="ID-JAG Inspector with claims, header, payload, and signature"
            />
            <h5 className="mt-6 text-sm font-semibold">Payload claims</h5>
            <div className="mt-3 divide-y border-y">
              {claims.map(([claim, meaning]) => (
                <div
                  key={claim}
                  className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 py-3 text-sm"
                >
                  <code className="text-xs font-semibold text-foreground">
                    {claim}
                  </code>
                  <span className="text-muted-foreground">{meaning}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-b py-10">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(480px,620px)_minmax(0,1fr)]">
          <GuideImage
            src="/xaa-guide/xaa-neg-score-2.png"
            alt="Negative-test scorecard showing invalid ID-JAGs rejected"
          />
          <div>
            <SectionHeading
              number="4"
              title="Run negative tests"
              description="Send deliberately broken ID-JAGs and verify your authorization server rejects them."
            />
            <p className="text-sm leading-6 text-muted-foreground">
              Select <strong>Run negative tests</strong>. A strict check passes
              when the authorization server rejects the broken ID-JAG. The MCP
              server is not called during these checks. The scorecard uses the
              configured pre-registered or DCR client identity.
            </p>
            <div className="mt-6 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {strictNegativeTests.map((test) => (
                <div key={test} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>{test}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 border-t pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Policy probes
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Unknown subjects may be resolved or JIT-provisioned, and scope
                requests may be narrowed. Compare these observations with your
                deployment policy.
              </p>
              <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {policyProbes.map((test) => (
                  <div key={test} className="flex items-center gap-2 text-sm">
                    <HelpCircle className="h-4 w-4 shrink-0 text-amber-600" />
                    <span>{test}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-6 text-xs text-muted-foreground">
              These are targeted security and policy checks, not a full
              conformance test.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
