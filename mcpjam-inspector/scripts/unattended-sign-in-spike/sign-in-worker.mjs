// Spike-only. The worker owns the browser during authentication. A caller can
// request the configured connection, but cannot choose a URL, field, or vault item.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function onePasswordProvider({ passwordRef, otpRef }) {
  if (
    !passwordRef.startsWith("op://") ||
    !otpRef.startsWith("op://") ||
    !otpRef.endsWith("?attribute=otp")
  ) {
    throw new Error("Configure a password field and a generated OTP field");
  }
  // The vault generates the code. Its enrollment seed never enters this worker.
  async function read(reference) {
    try {
      const { stdout } = await exec("op", ["read", "--no-newline", reference], {
        timeout: 5000,
        maxBuffer: 4096,
      });
      return stdout;
    } catch {
      throw new Error("Vault field unavailable");
    }
  }
  return { password: () => read(passwordRef), code: () => read(otpRef) };
}

export async function signIn({ page, binding, request, credentials }) {
  if (request.project !== binding.project || request.seat !== binding.seat) {
    return { status: "connection_mismatch" };
  }
  const origin = binding.origin;
  const location = (path) => new URL(path, origin).href;
  // The fixture uses two ordinary top-level, script-free forms. No third-party
  // frames, subresources, or cross-origin form submissions are needed here.
  const guard = async (route) => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue();
  };
  const context = page.context();
  let submittedSecret = false;
  let canRelease = false;
  await context.route("**/*", guard);
  try {
    if (page.url() !== location("/login")) return { status: "unexpected_page" };
    const submit = async (path, destination, field, provider, valid) => {
      if (page.url() !== location(path)) return false;
      const form = page.locator('form[method="post"]').first();
      const action = await form.getAttribute("action");
      if (!action || new URL(action, page.url()).href !== location(destination))
        return false;
      const target = form.locator(field);
      if ((await target.count()) !== 1) return false;
      const value = await provider();
      if (!valid(value)) throw new Error("Credential unavailable");
      submittedSecret = true;
      await target.fill(value, { timeout: 5000 });
      await Promise.all([
        page.waitForURL((url) => url.href !== location(path), {
          timeout: 10000,
        }),
        form.getByRole("button").click({ timeout: 5000 }),
      ]);
      return true;
    };
    const accepted = await submit(
      "/login",
      "/password",
      'input[type="password"]',
      credentials.password,
      (value) => typeof value === "string" && value.length > 0,
    );
    if (!accepted) return { status: "unexpected_page" };
    if (page.url() === location("/human")) {
      canRelease = true;
      return { status: "needs_person" };
    }
    if (page.url() !== location("/challenge"))
      return { status: "password_rejected" };
    const verified = await submit(
      "/challenge",
      "/verify",
      'input[autocomplete="one-time-code"]',
      credentials.code,
      (value) => /^\d{6}$/.test(value),
    );
    if (!verified || page.url() !== location("/home"))
      return { status: "verification_failed" };
    const identity = await page
      .getByTestId("identity")
      .textContent({ timeout: 5000 });
    canRelease = identity === binding.seat;
    return canRelease ? { status: "signed_in" } : { status: "wrong_identity" };
  } catch {
    // Browser or subprocess exceptions may include input. Only report an outcome.
    return { status: "sign_in_failed" };
  } finally {
    if (submittedSecret && !canRelease) await context.close();
    else await context.unroute("**/*", guard);
  }
}
