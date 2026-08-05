/**
 * The tuning control.
 *
 * What is pinned here is the contract between the two audiences it serves: a
 * preset click has to write the same three numbers an Advanced drag would, and
 * neither may emit a knob the current scope cannot send — the swarm mutation
 * rejects `linkThreshold` outright, so leaking it turns a rebuild into a
 * validator error rather than a no-op.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClusterTuningControl } from "../ClusterTuningControl";
import {
  CLUSTER_TUNING_DEFAULTS,
  CLUSTER_TUNING_PRESETS,
} from "@/lib/cluster-tuning";

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("cluster-tuning-trigger"));
}

describe("ClusterTuningControl", () => {
  it("labels the trigger with the preset the last run matches", () => {
    const { rerender } = render(
      <ClusterTuningControl value={undefined} onApply={vi.fn()} />,
    );
    expect(screen.getByTestId("cluster-tuning-trigger")).toHaveTextContent(
      "Balanced",
    );

    rerender(
      <ClusterTuningControl
        value={CLUSTER_TUNING_PRESETS.detailed}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByTestId("cluster-tuning-trigger")).toHaveTextContent(
      "Detailed",
    );
  });

  it("reads Custom when the last run matches no preset", () => {
    render(
      <ClusterTuningControl
        value={{ ...CLUSTER_TUNING_DEFAULTS, maxClusters: 7 }}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByTestId("cluster-tuning-trigger")).toHaveTextContent(
      "Custom",
    );
  });

  it("applies the full preset when one is picked", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ClusterTuningControl value={undefined} onApply={onApply} />);

    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-preset-broad"));
    await user.click(screen.getByTestId("cluster-tuning-apply"));

    expect(onApply).toHaveBeenCalledWith(CLUSTER_TUNING_PRESETS.broad, undefined);
  });

  it("omits linkThreshold for a scope with no topic map", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ClusterTuningControl
        value={undefined}
        onApply={onApply}
        showLinkThreshold={false}
      />,
    );

    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-preset-detailed"));
    await user.click(screen.getByTestId("cluster-tuning-apply"));

    expect(onApply).toHaveBeenCalledWith(
      {
        maxClusters: CLUSTER_TUNING_PRESETS.detailed.maxClusters,
        minSeparation: CLUSTER_TUNING_PRESETS.detailed.minSeparation,
      },
      undefined,
    );
    expect(onApply.mock.calls[0][0]).not.toHaveProperty("linkThreshold");
  });

  it("hides the link-distance slider for a scope with no topic map", async () => {
    const user = userEvent.setup();
    render(
      <ClusterTuningControl
        value={undefined}
        onApply={vi.fn()}
        showLinkThreshold={false}
      />,
    );
    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-advanced-toggle"));

    expect(
      screen.getByTestId("cluster-tuning-value-maxClusters"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("cluster-tuning-value-linkThreshold"),
    ).not.toBeInTheDocument();
  });

  it("exposes the raw values under Advanced", async () => {
    const user = userEvent.setup();
    render(
      <ClusterTuningControl
        value={CLUSTER_TUNING_PRESETS.broad}
        onApply={vi.fn()}
      />,
    );
    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-advanced-toggle"));

    expect(
      screen.getByTestId("cluster-tuning-value-maxClusters"),
    ).toHaveTextContent(String(CLUSTER_TUNING_PRESETS.broad.maxClusters));
    expect(
      screen.getByTestId("cluster-tuning-value-minSeparation"),
    ).toHaveTextContent(CLUSTER_TUNING_PRESETS.broad.minSeparation.toFixed(2));
  });

  it("does not apply while the popover is open — the draft is local", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ClusterTuningControl value={undefined} onApply={onApply} />);

    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-preset-broad"));
    // A slider that re-clustered on every change would queue a rebuild per drag.
    expect(onApply).not.toHaveBeenCalled();
  });

  it("re-seeds the draft from the applied value on reopen", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ClusterTuningControl value={undefined} onApply={onApply} />);

    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-preset-detailed"));
    await user.keyboard("{Escape}");

    await open(user);
    expect(
      screen.getByTestId("cluster-tuning-preset-description"),
    ).toHaveTextContent(/default/i);
  });

  it("puts the expensive re-analysis behind a confirmation that names the cost", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ClusterTuningControl
        value={undefined}
        onApply={onApply}
        sessionCount={4300}
      />,
    );

    await open(user);
    await user.click(screen.getByTestId("cluster-tuning-force"));
    expect(screen.getByText(/4,300 sessions will be re-analyzed/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("cluster-tuning-force-confirm"));
    expect(onApply).toHaveBeenCalledWith(CLUSTER_TUNING_DEFAULTS, {
      force: true,
    });
  });

  it("disables applying while a rebuild is in flight", async () => {
    const user = userEvent.setup();
    render(
      <ClusterTuningControl value={undefined} onApply={vi.fn()} busy />,
    );
    await open(user);
    expect(screen.getByTestId("cluster-tuning-apply")).toBeDisabled();
  });
});
