import { describe, it, expect, vi, afterEach } from "vitest";
import { mountAutoTopupCard } from "../auto-topup-stripe";
describe("automatic refill card setup", () => {
  afterEach(() => {
    delete window.Stripe;
  });
  it("mounts Stripe's card element and requires succeeded setup", async () => {
    const card = { mount: vi.fn(), destroy: vi.fn() };
    const confirmCardSetup = vi
      .fn()
      .mockResolvedValue({
        setupIntent: { id: "seti_1", status: "succeeded" },
      });
    window.Stripe = vi
      .fn()
      .mockReturnValue({
        elements: () => ({ create: () => card }),
        confirmCardSetup,
      });
    const element = document.createElement("div");
    const session = await mountAutoTopupCard("pk_test_example", element);
    expect(card.mount).toHaveBeenCalledWith(element);
    await session.confirm("secret", "seti_1");
    expect(confirmCardSetup).toHaveBeenCalledWith("secret", {
      payment_method: { card },
    });
    confirmCardSetup.mockResolvedValue({
      setupIntent: { id: "seti_1", status: "processing" },
    });
    await expect(session.confirm("secret", "seti_1")).rejects.toThrow(
      /not completed/,
    );
    confirmCardSetup.mockResolvedValue({ error: { message: "Card declined" } });
    await expect(session.confirm("secret", "seti_1")).rejects.toThrow(
      "Card declined",
    );
    session.destroy();
    expect(card.destroy).toHaveBeenCalledOnce();
  });
  it("refuses missing environment keys before loading Stripe", async () => {
    await expect(
      mountAutoTopupCard("", document.createElement("div")),
    ).rejects.toThrow(/configured/);
  });
});
