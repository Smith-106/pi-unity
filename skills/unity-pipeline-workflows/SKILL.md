---
name: unity-pipeline-workflows
description: Recompile code or run focused Unity tests through a reachable com.unity.pipeline Editor without launching, closing, or manually polling another Unity process.
---

# Unity Pipeline Workflows

Use this workflow only for an already-running exact project copy with `com.unity.pipeline` installed and reachable.

## Preferred typed tools

Use one typed tool call for each supported connected operation:

- `unity_pipeline_recompile` for connected script compilation.
- `unity_run_tests` for one compatible `EditMode` or `PlayMode` test-name or category selection.

These tools resolve the exact copy, require advertised commands, inspect lifecycle state, dispatch once, validate identity, and poll internally with a fixed deadline. Do not recreate their wait loops with `bash`, `unity recompile_status`, or `unity test_status` calls.

A timeout or malformed response is uncertain: the Unity operation may still be running. Do not cancel, retry, launch batchmode, close the Editor, or claim a result without a new user-authorized decision. The only automatic retry is Pipeline 0.5's explicit initial-settling `Server Busy` response for `unity_pipeline_recompile` or `unity_run_tests`, which confirms that a main-thread command was rejected before dispatch.

## Preconditions and boundaries

1. Pass an explicit `path` when multiple project copies may be found; paths identify copies, not display names.
2. The typed tools require a reachable exact-copy Pipeline and advertised `editor_status` plus operation commands. A different connected client is not itself a project lock.
3. `unity_pipeline_recompile` never sends `editor_stop` or overrides Unity's Script Changes While Playing preference. Known recompile-and-continue, stop-and-recompile, and defer policies proceed according to Unity's configured behavior. Pipeline 0.4 does not currently expose that preference, so the tool reports the unavailable policy while allowing recompilation to proceed. `unity_run_tests` may dispatch advertised `editor_stop` when needed, then verifies Edit Mode before running tests. The tools never enter Play Mode, pause, save, launch, or close Unity; recompilation may perform Unity's normal asset refresh/import and script-change behavior.
4. Test success requires a well-formed terminal result, a known positive executed count, and zero failures. An asynchronous initiation with `Total: 0` and `running` is nonterminal.
5. Routine tool output remains compact. Complete bounded terminal test records are persisted immediately in the durable normalized JSON artifact before Pipeline status can be displaced.

## Compile

Call `unity_pipeline_recompile` with optional `path` and `timeoutSeconds` (default 180, maximum 3600). It reports either up-to-date scripts or a compact completion summary, including whether an explicit agent exit, Unity-policy-driven behavior, or unavailable policy applied. A defer policy can mean recompilation waits until Play Mode ends. Compiler failures, identity changes, cancellation, malformed evidence, and deadline expiry are tool errors.

## Focused tests

Call `unity_run_tests` with:

- required `testPlatform`: `EditMode` or `PlayMode`;
- optional `testFilters` or `testCategories`: at most one selector family and one selector for connected execution;
- optional `execution`, `path`, and `timeoutSeconds` (default 600, maximum 3600).
- before running PlayMode tests, check the Game View focus setting. Set it to Play Unfocused for the test run, then restore the previous setting afterward.

The tool treats `no_tests`, idle, and not-started statuses as safe inactivity, detects a pre-existing active connected test before dispatch, and stops rather than claiming or replacing active work. It captures returned mode/filter/run identity fields when available and stops as uncertain if status is clearly displaced by another run.

### Two independent fixtures in an open Editor

Keep the Editor open. For an authorized request for two known non-overlapping fixtures, use the same explicit exact-copy `path` and platform, one selector per call. For example, replace `./SyntheticGame` with the selected project path and issue this `unity_run_tests` call:

```json
{"path":"./SyntheticGame","testPlatform":"EditMode","execution":"connected","testFilters":["Synthetic.InventoryFixture"]}
```

Await the completed tool result and inspect its outcome and exact normalized artifact path. Only after a passing result, issue the second call (not in parallel or pre-queued in the same turn):

```json
{"path":"./SyntheticGame","testPlatform":"EditMode","execution":"connected","testFilters":["Synthetic.DialogueFixture"]}
```

Stop the remaining sequence on failure, timeout, cancellation, malformed evidence, displaced identity, or any uncertainty; report the first result and the remaining fixture as not run. Do not retry, close the Editor, switch to isolated execution, or broaden to a parent suite/category or empty selectors. Empty/omitted selectors select all tests. Keep each result's artifact separately; do not treat one fixture's evidence as covering the other.

For a single category use `testCategories: ["SyntheticCategory"]` and omit `testFilters`. Never combine the two families or join selectors with semicolons. Multiple-selector rejection means no test was dispatched: use the serial recipe only for independent, non-overlapping selections without other isolated-only requirements. If overlap or intended filter/category intersection semantics are unclear, stop for clarification rather than split, duplicate, or broaden tests. Required XML, retries, coverage, or other isolated-only options still need a deliberate isolation decision, not argument stripping.

## Bounded raw CLI troubleshooting only

Normally call the typed tools, not raw CLI commands. If a typed tool is unavailable in an older installed package and a user specifically authorizes troubleshooting, first use `unity_project_status` and require advertised `recompile_status` or `run_tests` and `test_status`. Use the documented asynchronous form with `--async_tests true`, one fixed deadline, and bounded backoff; parse object and stringified nested JSON. `Total: 0` with `result: running` is a valid nonterminal initiating response. Passing evidence reports successful completion, a known positive executed-test count, and zero failures; nested `success:false`, changed exact-copy identity, or polling timeout is non-passing uncertainty. Do not silently fall back to batchmode after uncertain connected dispatch. Connected work does not guarantee NUnit XML.

## When not to use connected tools

Use `unity_run_tests` with `execution: "isolated"` for a closed project, intentional isolation/CI, multiple selectors in one run, retries, sharding, coverage, or required NUnit/JUnit evidence. Multiple independent fixtures alone do not require closing a reachable Editor: use the serial recipe above. A single category is supported connected when Pipeline advertises the command; do not claim broader connected selector support. Do not use batchmode as an automatic fallback after an uncertain connected dispatch.

Use the typed compile/test tools when their polling and terminal evidence fit the task. Advertised Pipeline `eval` remains available through `unity_pipeline_eval` for bounded project-specific inspection or operations outside those typed workflows; its `timeoutSeconds` range is 1–86,400 seconds, and a timeout remains uncertain without cancellation or retry. It is an assistance surface, not a forbidden fallback or a substitute for the typed tools' completion protocol. Eval compiles arbitrary C# with Roslyn on the Editor main thread, so ordinary properties and local-variable snippets are valid; it is not expression-only or reliably statically read-only. Prefer typed tools for their stronger evidence, but let user intent and project guidance govern mutations. Lifecycle, persistent-setting, destructive, asset, scene-save, package, build, and test mutations require explicit authorization.
