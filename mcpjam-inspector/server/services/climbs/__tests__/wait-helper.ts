import { runGroupIdFor } from "../run-group-id.js";
import { SUITE } from "./helpers.js";

export const wait = { groupId: (key: string) => runGroupIdFor(SUITE, key) };
