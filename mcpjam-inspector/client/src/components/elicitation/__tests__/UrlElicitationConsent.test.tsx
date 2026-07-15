import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UrlElicitationConsent } from "../UrlElicitationConsent";

const request = {
  rendezvousId: "rv-1",
  serverId: "srv-github",
  serverName: "GitHub",
  message: "Connect your account to continue.",
  url: "https://github.com/login/oauth/authorize?client_id=abc",
};

let openSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openSpy = vi.fn(() => ({ opener: {}, location: { replace: vi.fn() } }));
  vi.stubGlobal("open", openSpy);
  // Any network call from this component would be the pre-fetch the spec bans.
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UrlElicitationConsent", () => {
  it("shows the full url and the requesting server before any consent", () => {
    render(<UrlElicitationConsent request={request} onResponse={vi.fn()} />);

    // Full URL, not a label or a truncation.
    expect(screen.getByText(/github\.com/)).toBeInTheDocument();
    expect(
      screen.getByText("/login/oauth/authorize?client_id=abc"),
    ).toBeInTheDocument();
    // Spec: the client MUST make clear which server is asking. serverId is the
    // trusted anchor, shown alongside the friendly name.
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("srv-github")).toBeInTheDocument();
  });

  it("never renders the destination as a clickable link", () => {
    const { container } = render(
      <UrlElicitationConsent request={request} onResponse={vi.fn()} />,
    );
    // A reflex click must be impossible: consent has to be a deliberate act.
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("performs no network activity", () => {
    render(<UrlElicitationConsent request={request} onResponse={vi.fn()} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens with opener isolation and only then accepts", () => {
    const location = { replace: vi.fn() };
    const win: any = { opener: {}, location };
    openSpy.mockReturnValue(win);
    const onResponse = vi.fn();

    render(<UrlElicitationConsent request={request} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole("button", { name: /open in new tab/i }));

    // about:blank first — `window.open(url, "_blank", "noopener")` returns null
    // even on success, so it can't distinguish blocked from opened.
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(win.opener).toBeNull();
    expect(location.replace).toHaveBeenCalledWith(request.url);
    expect(onResponse).toHaveBeenCalledWith("accept");
  });

  it("withholds accept when the popup is blocked", () => {
    openSpy.mockReturnValue(null);
    const onResponse = vi.fn();

    render(<UrlElicitationConsent request={request} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole("button", { name: /open in new tab/i }));

    // The user never reached the page, so claiming they consented would be a lie.
    expect(onResponse).not.toHaveBeenCalled();
    expect(screen.getByText(/blocked the new tab/i)).toBeInTheDocument();
  });

  it("sends decline when declined", () => {
    const onResponse = vi.fn();
    render(<UrlElicitationConsent request={request} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(onResponse).toHaveBeenCalledWith("decline");
  });

  it("refuses to open a non-http scheme and explains why", () => {
    const onResponse = vi.fn();
    render(
      <UrlElicitationConsent
        request={{ ...request, url: "javascript:alert(1)" }}
        onResponse={onResponse}
      />,
    );

    expect(screen.getByText(/won't open/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open in new tab/i })).toBeDisabled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("warns about a punycode host", () => {
    render(
      <UrlElicitationConsent
        request={{ ...request, url: "https://xn--80ak6aa92e.com/login" }}
        onResponse={vi.fn()}
      />,
    );
    expect(screen.getByText(/look like a different/i)).toBeInTheDocument();
  });

  it("advisory mode hides decline but still opens and reports", () => {
    // The -32042 path: the tool already failed, so there's nothing to decline.
    // onResponse still fires — the parent reads it as dismissal. An earlier
    // cut suppressed it entirely, which made the dialog impossible to close.
    const location = { replace: vi.fn() };
    openSpy.mockReturnValue({ opener: {}, location });
    const onResponse = vi.fn();

    render(
      <UrlElicitationConsent request={request} onResponse={onResponse} advisory />,
    );
    expect(
      screen.queryByRole("button", { name: /decline/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open in new tab/i }));
    expect(location.replace).toHaveBeenCalledWith(request.url);
    expect(onResponse).toHaveBeenCalledWith("accept");
  });

  it("shows embedded credentials rather than hiding them", () => {
    // The dialog promises the FULL url and warns that userinfo can disguise a
    // destination — hiding the segment we warn about would be worse than useless.
    render(
      <UrlElicitationConsent
        request={{ ...request, url: "https://example.com@evil.test/x" }}
        onResponse={vi.fn()}
      />,
    );
    expect(screen.getByText("example.com@")).toBeInTheDocument();
    expect(screen.getByText("evil.test")).toBeInTheDocument();
    expect(screen.getByText(/disguise the real destination/i)).toBeInTheDocument();
  });
});
