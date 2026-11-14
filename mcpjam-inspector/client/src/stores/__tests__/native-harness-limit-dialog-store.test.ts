import { beforeEach, describe, expect, it } from "vitest";
import { useNativeHarnessLimitDialogStore } from "../native-harness-limit-dialog-store";

const store = () => useNativeHarnessLimitDialogStore.getState();

beforeEach(() => {
  useNativeHarnessLimitDialogStore.setState({
    notice: null,
    noticeKeys: [],
    notifiedKeys: new Set(),
  });
});

describe("useNativeHarnessLimitDialogStore", () => {
  it("opens with the notice and closes", () => {
    store().open({ organizationId: "org_1" });
    expect(store().notice).toEqual({ organizationId: "org_1" });

    store().close();
    expect(store().notice).toBeNull();
  });

  it("opens again for every refusal that names no run", () => {
    // Each Playground send is its own refusal and the person's own action.
    store().open({});
    store().close();
    store().open({});
    expect(store().notice).toEqual({});
  });

  it("announces a run once, so a dismissal survives its view's next update", () => {
    store().open({ organizationId: "org_1" }, ["run:run_1"]);
    store().close();

    store().open({ organizationId: "org_1" }, ["run:run_1"]);
    expect(store().notice).toBeNull();
  });

  it("announces a swarm wave once, whichever of its runs reports it", () => {
    store().open({}, ["run:run_1", "wave:wave_1"]);
    store().close();

    store().open({}, ["run:run_2", "wave:wave_1"]);
    expect(store().notice).toBeNull();
  });

  it("learns the wave of a run first reported alone", () => {
    store().open({}, ["run:run_1"]);
    store().close();
    // The same run again, now that its document names the wave.
    store().open({}, ["run:run_1", "wave:wave_1"]);
    expect(store().notice).toBeNull();

    store().open({}, ["run:run_2", "wave:wave_1"]);
    expect(store().notice).toBeNull();
  });

  it("announces another run", () => {
    store().open({}, ["run:run_1"]);
    store().close();

    store().open({ organizationId: "org_2" }, ["run:run_2"]);
    expect(store().notice).toEqual({ organizationId: "org_2" });
  });

  it("takes the organization a later report of the open notice's run names", () => {
    store().open({}, ["run:run_1"]);
    store().open({ organizationId: "org_1" }, ["run:run_1", "wave:wave_1"]);
    expect(store().notice).toEqual({ organizationId: "org_1" });

    // Once named, the notice keeps its organization.
    store().open({ organizationId: "org_2" }, ["run:run_1"]);
    expect(store().notice).toEqual({ organizationId: "org_1" });
  });

  it("neither reopens a closed notice nor names it after another run", () => {
    store().open({}, ["run:run_1"]);
    store().close();
    store().open({ organizationId: "org_1" }, ["run:run_1"]);
    expect(store().notice).toBeNull();

    store().open({}, ["run:run_2"]);
    store().open({ organizationId: "org_1" }, ["run:run_1"]);
    expect(store().notice).toEqual({});
  });

  it("closes a notice by its serial only until another replaces it", () => {
    store().open({}, ["run:run_1"]);
    const first = store().noticeSerial;
    store().open({ organizationId: "org_2" }, ["run:run_2"]);

    store().closeNotice(first);
    expect(store().notice).toEqual({ organizationId: "org_2" });

    store().closeNotice(store().noticeSerial);
    expect(store().notice).toBeNull();
  });
});
