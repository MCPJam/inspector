---
"@mcpjam/sdk": minor
---

A mock tool can declare `state: { op, collection, key?, where?, limit?, cursor?, value?, set?, result? }` with `op` one of `get`, `list`, `create`, `patch` or `delete`, and a definition can carry a `seed` of records by collection and key. `validateMockDefinition` checks each declaration and names the field path of a mistake, and refuses a tool that has both a saved answer and `state`; `checkStateOutputs(definition, realTools?)` checks each declared result against the tool's output schema using the seed. `buildMock` serves these tools from a host-supplied `MockRecordStore` (`BuildMockOptions.records`, with the state context: the version's shared records or a run's copy at its epoch). A write can carry an operation key in the request's `_meta["mcpjam.com/operationKey"]`; the store returns the saved outcome for a repeat and refuses a conflicting one. New exports: `MockRecordStore`, `MockRecords`, `MockStateContext`, `MockRecordOp`, `MockRecordOutcome`, `OPERATION_KEY_META`, `operationKeyMeta`, `fingerprintToolCall`, `checkStateOutputs`, `MockToolState`, `MockSeed`.

A seed over 2000 records is refused at save (`MOCK_SEED_MAX_RECORDS`), a store can answer `records_full` when a scope holds 10,000, and a mock call event carries `catchAll` beside `caseIndex`.
