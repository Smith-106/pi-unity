import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import registerProjectArtifacts from "@aefree/pi-project-artifacts/pi";
import { resolveArtifactProfilesV1, resolveArtifactSearchServiceV1, resolveTodoLifecycleServiceV1 } from "@aefree/pi-project-artifacts/contracts/v1";
import { resolveFileDiscoveryFiltersV1 } from "@aefree/pi-file-discovery/contracts/v1";
import { ExtensionRunner, initTheme } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import registerUnity from "../index";
import { writeNormalizedUnityTestArtifact, type NormalizedUnityTestResult } from "../src/unity-tests";

initTheme("dark");

function fakePi(exec: (command: string, args: string[]) => Promise<any> = async () => ({ code: 0, stdout: "", stderr: "" })) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools: any[] = [];
  const commands: any[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  let activeTools: string[] = [];
  return {
    handlers, tools, commands, entries,
    on(name: string, handler: (event: any, ctx: any) => unknown) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(tool: any) { tools.push(tool); activeTools.push(tool.name); },
    registerCommand(name: string, command: any) { commands.push({ name, ...command }); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
    exec: (command: string, args: string[]) => exec(command, args),
    events: { emit() {}, on() {} },
  };
}
async function emit(pi: ReturnType<typeof fakePi>, name: string, ctx: any) { for (const handler of pi.handlers.get(name) ?? []) await handler({ reason: name === "session_start" ? "startup" : "quit" }, ctx); }

// Exercise Pi's actual native finalizer and extension middleware, not an imitation
// that treats execute().details.status (or a returned isError field) as failure.
// Resolve agent-core through the installed host so this works with nested npm deps.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const coreManifestPath = hostRequire.resolve("@earendil-works/pi-agent-core/package.json");
const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
const { runAgentLoop } = await import(new URL(coreManifest.exports["."].import, pathToFileURL(coreManifestPath)).href);
async function nativeToolResult(pi: ReturnType<typeof fakePi>, tool: any, params: any, ctx: any) {
  const runner = new ExtensionRunner([{ path: "synthetic-unity-extension", handlers: pi.handlers } as any], {} as any, ctx.cwd, ctx.sessionManager, {} as any);
  const errors: unknown[] = [];
  runner.onError(error => errors.push(error));
  const events: any[] = [];
  let executed: any;
  const messages = await runAgentLoop([], { systemPrompt: "Offline deterministic tool-result test", messages: [], tools: [{ ...tool, execute: async (...args: any[]) => { executed = await tool.execute(...args, ctx); return executed; } }] }, {
    model: { id: "synthetic", provider: "synthetic", api: "openai-completions" },
    convertToLlm: (messages: any[]) => messages,
    shouldStopAfterTurn: () => true,
    afterToolCall: ({ toolCall, args, result, isError }: any) => runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: result.content, details: result.details, isError }),
  }, (event: any) => { events.push(event); }, undefined, () => {
    const stream = createAssistantMessageEventStream();
    const response = { role: "assistant", content: [{ type: "toolCall", id: "synthetic-call", name: tool.name, arguments: params }], api: "openai-completions", provider: "synthetic", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 };
    stream.push({ type: "done", reason: "toolUse", message: response });
    stream.end(response);
    return stream;
  });
  assert.deepEqual(errors, [], "Native extension hooks must not fail silently.");
  const result = messages.find((message: any) => message.role === "toolResult");
  assert(result, "Native finalizer emitted a tool result.");
  assert.equal(events.find(event => event.type === "tool_execution_end")?.isError, result.isError, "Native execution event and stored result agree.");
  if (executed) {
    assert.deepEqual(result.details, executed.details, "Native failure must retain structured details unchanged.");
    assert.deepEqual(result.content, executed.content, "Native failure must retain bounded diagnostics unchanged.");
  }
  return result;
}

for (const order of ["artifacts-first", "unity-first"] as const) {
  const scope = {};
  const ctx = { cwd: process.cwd(), sessionManager: scope, mode: "print", hasUI: false, ui: {} };
  const artifacts = fakePi();
  const unity = fakePi();
  registerProjectArtifacts(artifacts as any);
  registerUnity(unity as any);
  // The shared Pi host advertises separately loaded optional packages globally.
  unity.setActiveTools(["project_artifact_search", "discover_candidate_files"]);
  if (order === "artifacts-first") { await emit(artifacts, "session_start", ctx); await emit(unity, "session_start", ctx); }
  else { await emit(unity, "session_start", ctx); await emit(artifacts, "session_start", ctx); }
  assert.equal(resolveArtifactSearchServiceV1(scope).outcome, "available", order);
  assert.equal(resolveTodoLifecycleServiceV1(scope).outcome, "available", order);
  assert.equal(resolveArtifactProfilesV1(scope).outcome, "available", order);
  assert.equal(resolveFileDiscoveryFiltersV1(scope).outcome, "available", order);
  assert.equal(unity.tools.filter((tool) => tool.name === "unity_migrate_solution_docs").length, 0);
  const openEditorTool = unity.tools.find((tool) => tool.name === "unity_open_editor");
  assert(openEditorTool, "pi-unity must register the Unity Editor launcher tool");
  assert.equal(openEditorTool.parameters.additionalProperties, false, "Open Editor schema must be strict.");
  assert.equal(openEditorTool.parameters.properties.unityEditorPath, undefined, "Open Editor must not expose a version-unverified Editor-path override.");
  assert.equal(openEditorTool.parameters.properties.automated.default, false);
  assert.match(openEditorTool.parameters.properties.automated.description, /Unity Editor's -automated flag/);
  const batchmodeTool = unity.tools.find((tool) => tool.name === "unity_launch_batchmode");
  assert(batchmodeTool, "pi-unity must register the batchmode launcher tool");
  assert.equal(batchmodeTool.parameters.additionalProperties, false, "Batchmode schema must be strict.");
  assert.equal(batchmodeTool.parameters.properties.unityEditorPath, undefined, "Legacy Editor-path arguments must be schema-invalid rather than ignored.");
  const recompileTool = unity.tools.find((tool) => tool.name === "unity_pipeline_recompile");
  const pipelineTestTool = unity.tools.find((tool) => tool.name === "unity_run_tests");
  assert(recompileTool && pipelineTestTool, "pi-unity must register recompile and the unified test tool");
  assert.equal(recompileTool.parameters.additionalProperties, false, "Pipeline recompile schema must be strict.");
  assert.equal(pipelineTestTool.parameters.additionalProperties, false, "Pipeline test schema must be strict.");
  assert.deepEqual(pipelineTestTool.parameters.properties.testPlatform.enum, ["EditMode", "PlayMode"]);
  assert.deepEqual(pipelineTestTool.parameters.properties.execution.enum, ["auto", "connected", "isolated"]);
  assert.equal(unity.tools.some((tool) => tool.name === "unity_pipeline_run_tests" || tool.name === "unity_run_test_batch"), false, "Legacy test tools must not be registered.");
  const evalTool = unity.tools.find((tool) => tool.name === "unity_pipeline_eval");
  assert(evalTool, "pi-unity must register Pipeline eval as the primary C# REPL tool");
  assert.equal(evalTool.parameters.additionalProperties, false);
  assert.equal(evalTool.parameters.properties.code.maxLength, 4000);
  const inspectionTool = unity.tools.find((tool) => tool.name === "unity_pipeline_inspect");
  assert(inspectionTool, "pi-unity must register the purpose-built Pipeline inspection tool");
  assert.equal(inspectionTool.parameters.additionalProperties, false);
  assert.deepEqual(inspectionTool.parameters.properties.command.enum, [
    "get_authoring_root", "get_build_settings", "get_player_settings", "get_scene_hierarchy",
    "editor_status", "list_open_scenes", "list_build_targets",
  ], "The inspection schema must advertise only package-owned purpose-built commands.");
  assert.match(inspectionTool.promptGuidelines.join(" "), /never launches or closes Unity/i);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendererContext = { lastComponent: undefined };
  const testCall = pipelineTestTool.renderCall({ path: "C:/Game", testPlatform: "EditMode", testFilter: "Game.Fast" }, theme, rendererContext);
  assert.match(testCall.render(300).join("\n"), /EditMode • Game.Fast/, "Test call headers retain platform and bounded filter.");
  const reusedTestCall = pipelineTestTool.renderCall({ path: "C:/Game", testPlatform: "PlayMode", testFilter: "secret=visible" }, theme, { lastComponent: testCall });
  assert.equal(reusedTestCall, testCall, "Pipeline call renderer reuses the prior Text component.");
  assert.match(reusedTestCall.render(300).join("\n"), /secret=\[redacted\]/i, "Sensitive-looking filter values are redacted.");
  const evalCall = evalTool.renderCall({ code: "return api_key=super-secret-value;" }, theme, rendererContext);
  assert.match(evalCall.render(300).join("\n"), /api_key=\[redacted\]/i, "Eval previews redact sensitive-looking values.");
  for (const code of [
    'password = "correct horse battery staple"; return password;',
    "token: 'multi word value'",
    'PASSWORD = "correct \\"horse\\" battery staple";',
  ]) {
    const rendered = evalTool.renderCall({ code }, theme, rendererContext).render(300).join("\n");
    assert.match(rendered, /(password|token)\s*[:=]\[redacted\]/i, "Quoted sensitive values are fully redacted.");
    for (const fragment of ["horse", "battery", "staple", "multi word value"]) {
      assert(!rendered.includes(fragment), `Sensitive fragment must not survive renderer redaction: ${fragment}`);
    }
  }
  const inspectCall = inspectionTool.renderCall({ command: "get_scene_hierarchy" }, theme, rendererContext);
  assert.match(inspectCall.render(300).join("\n"), /command=get_scene_hierarchy/);
  const partial = pipelineTestTool.renderResult({ content: [{ type: "text", text: "Unity EditMode tests running; 1.0s elapsed." }], details: {} }, { expanded: false, isPartial: true }, theme, rendererContext);
  assert.match(partial.render(300).join("\n"), /Unity/);
  const completedResult = {
    content: [{ type: "text", text: "Unity EditMode tests passed for C:/Game: 21 executed, 21 passed, 0 failed." }],
    details: { mode: "pipeline", status: "passed", pipeline: { operation: "tests", terminalState: "completed", elapsedSeconds: 2.4, testPlatform: "EditMode", counts: { total: 21, passed: 21, failed: 0 }, playModeHandling: "not_playing" } },
  };
  const completed = pipelineTestTool.renderResult(completedResult, { expanded: false, isPartial: false }, theme, { lastComponent: partial });
  assert(completed, "Unified test renderer returns a result component.");
  assert.match(completed.render(300).join("\n"), /Unity/);
  assert.match(completed.render(300).join("\n"), /Unity/, "Collapsed test results render.");
  const expanded = pipelineTestTool.renderResult(completedResult, { expanded: true, isPartial: false }, theme, { lastComponent: completed });
  assert(expanded, "Unified test renderer expands results.");
  assert.match(expanded.render(300).join("\n"), /Unity EditMode tests passed for C:\/Game/, "Expanded Pipeline results show the bounded model-visible evidence.");
  const recompileWithoutPlayModeDetails = recompileTool.renderResult({
    content: [{ type: "text", text: "Unity recompile completed." }],
    details: { mode: "pipeline", status: "passed", pipeline: { operation: "recompile", terminalState: "completed", elapsedSeconds: 1.2 } },
  }, { expanded: false, isPartial: false }, theme, rendererContext);
  assert.match(recompileWithoutPlayModeDetails.render(300).join("\n"), /Unity recompile completed • 1.2s/, "Optional Play Mode details may be absent without breaking rendering.");
  const collapsedEval = evalTool.renderResult({ content: [{ type: "text", text: "Unity Pipeline eval completed.\n42" }], details: { mode: "pipeline_eval", status: "passed", pipelineEval: { outcome: "dispatched", command: "eval", output: "42", truncated: false } } }, { expanded: false, isPartial: false }, theme, rendererContext);
  assert.match(collapsedEval.render(300).join("\n"), /42/, "Collapsed eval output remains useful.");
  const rejectedEval = evalTool.renderResult({ content: [{ type: "text", text: "Unity Pipeline eval rejected: eval_failed\nRoslyn compilation failed." }], details: { mode: "pipeline_eval", status: "failed", pipelineEval: { outcome: "rejected", code: "eval_failed", message: "Roslyn compilation failed." } } }, { expanded: false, isPartial: false }, theme, { lastComponent: collapsedEval });
  assert.equal(rejectedEval, collapsedEval, "Rejected eval results reuse the prior Text component.");
  assert.match(rejectedEval.render(300).join("\n"), /Roslyn compilation failed/, "Rejected eval summaries remain visible while collapsed.");
  assert.equal(artifacts.tools.filter((tool) => tool.name === "project_artifact_search").length, 1);
  await emit(unity, "session_shutdown", ctx);
  await emit(artifacts, "session_shutdown", ctx);
  assert.equal(resolveArtifactProfilesV1(scope).outcome, "missing");
  assert.equal(resolveFileDiscoveryFiltersV1(scope).outcome, "missing");
  assert.equal(resolveArtifactSearchServiceV1(scope).outcome, "missing");
  assert.equal(resolveTodoLifecycleServiceV1(scope).outcome, "missing");
}

{
  const scopeA = {};
  const scopeB = {};
  const unity = fakePi();
  registerUnity(unity as any);
  unity.setActiveTools(["project_artifact_search", "discover_candidate_files"]);
  const ctxA = { cwd: process.cwd(), sessionManager: scopeA, mode: "print", hasUI: false, ui: {} };
  const ctxB = { ...ctxA, sessionManager: scopeB };
  await emit(unity, "session_start", ctxA);
  await emit(unity, "session_start", ctxB);
  assert.equal(resolveArtifactProfilesV1(scopeA).outcome, "available");
  assert.equal(resolveArtifactProfilesV1(scopeB).outcome, "available");
  assert.equal(resolveFileDiscoveryFiltersV1(scopeA).outcome, "available");
  assert.equal(resolveFileDiscoveryFiltersV1(scopeB).outcome, "available");
  await emit(unity, "session_shutdown", ctxA);
  assert.equal(resolveArtifactProfilesV1(scopeA).outcome, "missing");
  assert.equal(resolveFileDiscoveryFiltersV1(scopeA).outcome, "missing");
  assert.equal(resolveArtifactProfilesV1(scopeB).outcome, "available", "delayed old-session shutdown must preserve newer active scope");
  assert.equal(resolveFileDiscoveryFiltersV1(scopeB).outcome, "available", "delayed old-session shutdown must preserve newer active scope");
  await emit(unity, "session_shutdown", ctxB);
  assert.equal(resolveArtifactProfilesV1(scopeB).outcome, "missing");
  assert.equal(resolveFileDiscoveryFiltersV1(scopeB).outcome, "missing");
}
{
  const root = await mkdtemp(join(tmpdir(), "pi-unity-plan-tool-"));
  const project = join(root, "Game");
  const calls: string[][] = [];
  try {
    await mkdir(join(project, "ProjectSettings"), { recursive: true });
    await mkdir(join(project, "Packages"), { recursive: true });
    await writeFile(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.0f1\n");
    await writeFile(join(project, "Packages", "manifest.json"), "{\"dependencies\":{}}\n");
    const canonicalProject = await realpath(project);
    const pi = fakePi(async (_command, args) => {
      calls.push(args);
      if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
      if (args.includes("pipeline") && args.includes("list")) return { code: 0, stdout: JSON.stringify({ success: true, data: { instances: [{ projectPath: canonicalProject, pid: 42, pipelineServer: { isReachable: true } }] } }), stderr: "" };
      if (args.includes("list")) return { code: 0, stdout: JSON.stringify({ success: true, data: { commands: ["get_authoring_root", "eval"] } }), stderr: "" };
      const connectedCommand = args[args.indexOf("--timeout") + 2];
      return connectedCommand === "eval"
        ? { code: 0, stdout: JSON.stringify({ success: true, data: { result: { success: true, result: 42, diagnostics: [] } } }), stderr: "" }
        : { code: 0, stdout: JSON.stringify({ success: true, data: { result: { root: "token=definitely-not-a-real-secret" } } }), stderr: "" };
    });
    registerUnity(pi as any);
    const ctx = { cwd: root, sessionManager: {}, mode: "print", hasUI: false, ui: {} };
    await emit(pi, "session_start", ctx);
    const pipelineInspection = pi.tools.find((item) => item.name === "unity_pipeline_inspect");
    const pipelineEval = pi.tools.find((item) => item.name === "unity_pipeline_eval");
    const result = await pipelineInspection.execute("test", { path: project, command: "get_authoring_root" }, undefined, undefined, ctx);
    assert.equal(result.details.pipelineInspection.outcome, "dispatched", JSON.stringify(result.details.pipelineInspection));
    assert.match(result.content[0].text, /token= \[redacted\]/);
    const evalResult = await pipelineEval.execute("eval", { path: project, code: "var s = UnityEngine.Application.dataPath; return s.Length;", timeoutSeconds: 86400 }, undefined, undefined, ctx);
    assert.equal(evalResult.details.pipelineEval.outcome, "dispatched", "The primary Pipeline eval tool must expose advertised arbitrary C# eval.");
    const evalCall = calls.find((args) => args.includes("var s = UnityEngine.Application.dataPath; return s.Length;"));
    assert.equal(evalCall?.[evalCall.indexOf("--timeout") + 1], "86400", "Eval forwards its selected deadline to Unity CLI.");
    assert(calls.some((args) => args.includes("get_authoring_root")), "The guarded handler must dispatch only after discovery.");
    assert(calls.some((args) => args.includes("var s = UnityEngine.Application.dataPath; return s.Length;")), "The primary eval tool must preserve a local-variable C# snippet.");
    assert(calls.every((args) => !args.includes("open") && !args.includes("run") && !args.includes("Exit")), "Connected inspection must not launch or close Unity.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
{
  const root = await mkdtemp(join(tmpdir(), "pi-unity-pipeline-tools-"));
  const project = join(root, "Game");
  const dispatched: string[] = [];
  try {
    await mkdir(join(project, "ProjectSettings"), { recursive: true });
    await mkdir(join(project, "Packages"), { recursive: true });
    await writeFile(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.0f1\n");
    await writeFile(join(project, "Packages", "manifest.json"), "{\"dependencies\":{\"com.unity.pipeline\":\"0.3.0-exp.1\"}}\n");
    const canonicalProject = await realpath(project);
    let playMode = true;
    const pi = fakePi(async (_command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
      if (args.includes("pipeline") && args.includes("list")) return { code: 0, stdout: JSON.stringify({ success: true, data: { instances: [{ projectPath: canonicalProject, pid: 42, pipelineServer: { isReachable: true } }] } }), stderr: "" };
      if (args.includes("list")) return { code: 0, stdout: JSON.stringify({ success: true, data: { commands: ["editor_status", "editor_stop", "recompile", "recompile_status", "run_tests", "test_status"] } }), stderr: "" };
      const command = args[args.indexOf("--timeout") + 2];
      dispatched.push(command);
      if (command === "editor_status") return { code: 0, stdout: JSON.stringify({ success: true, data: { result: { status: "ready", playMode: playMode ? "playing" : "stopped" } } }), stderr: "" };
      if (command === "editor_stop") { playMode = false; return { code: 0, stdout: JSON.stringify({ success: true, data: { result: "Exited play mode", success: true } }), stderr: "" }; }
      if (command === "recompile") return { code: 0, stdout: JSON.stringify({ success: true, data: { result: { status: "up_to_date" } } }), stderr: "" };
      if (command === "test_status") return { code: 0, stdout: JSON.stringify({ success: true, data: { result: JSON.stringify({ status: "no_tests", message: "No test run in progress" }) } }), stderr: "" };
      if (command === "run_tests") return { code: 0, stdout: JSON.stringify({ success: true, data: { result: { status: "completed", mode: "editor", summary: { total: 21, passed: 21, failed: 0 }, tests: [{ name: "Passing.Record", result: "Passed" }] } } }), stderr: "" };
      throw new Error(`Unexpected Pipeline command: ${String(command)}`);
    });
    registerUnity(pi as any);
    const notifications: string[] = [];
    const branch = () => pi.entries.map((entry, index) => ({ type: "custom", id: String(index), ...entry }));
    const ctxA = { cwd: root, sessionManager: { getBranch: () => [] }, mode: "print", hasUI: false, ui: { setStatus() {}, notify(message: string) { notifications.push(message); } } };
    const ctxB = { cwd: root, sessionManager: { getBranch: branch }, mode: "print", hasUI: false, ui: { setStatus() {}, notify(message: string) { notifications.push(message); } } };
    await emit(pi, "session_start", ctxA);
    await emit(pi, "session_start", ctxB);
    const recompile = pi.tools.find((item) => item.name === "unity_pipeline_recompile");
    const tests = pi.tools.find((item) => item.name === "unity_run_tests");
    const projectStatus = pi.tools.find((item) => item.name === "unity_project_status");
    const statusResult = await projectStatus.execute("status-call", { path: project }, undefined, undefined, ctxA);
    assert.match(statusResult.content[0].text, /declared Unity 6000\.1\.0f1/, "Project status lazily loads the declared version required for Pipeline capability checks.");
    const defaultTestResult = await tests.execute("default-test-call", { path: project, testPlatform: "EditMode" }, undefined, undefined, ctxA);
    assert.match(defaultTestResult.content[0].text, /21 executed/);
    assert.equal(dispatched.includes("editor_stop"), true, "Play Mode exit is allowed by default.");
    const playModeCommand = pi.commands.find((item) => item.name === "unity-playmode-exit");
    await playModeCommand.handler("disallow", ctxA);
    assert.deepEqual(pi.entries.at(-1), { customType: "pi-unity-session-settings-v1", data: { allowAutonomousPlayModeExit: false } });
    assert.match(notifications.at(-1) ?? "", /disabled/);
    playMode = true;
    await playModeCommand.handler("allow", ctxB);
    assert.deepEqual(pi.entries.at(-1), { customType: "pi-unity-session-settings-v1", data: { allowAutonomousPlayModeExit: true } });
    await assert.rejects(() => tests.execute("isolated-session-test-call", { path: project, testPlatform: "EditMode" }, undefined, undefined, ctxA), /Play Mode exit is disabled/, "An explicit session restriction must not be changed by another session.");
    await emit(pi, "session_shutdown", ctxA);
    await emit(pi, "session_start", ctxB); // Session reload/resume reconstructs B's explicit toggle from its branch entries.
    const compileResult = await recompile.execute("compile-call", { path: project }, undefined, undefined, ctxB);
    const testResult = await tests.execute("test-call", { path: project, testPlatform: "EditMode" }, undefined, undefined, ctxB);
    assert.match(compileResult.content[0].text, /up to date/);
    assert.equal(compileResult.details.pipeline.exitedPlayMode, false, "Recompile leaves lifecycle to Unity when editor_status lacks script-change policy.");
    assert.equal(compileResult.details.pipeline.playModeHandling, "policy_unknown");
    assert.match(compileResult.content[0].text, /did not send editor_stop/);
    assert.match(testResult.content[0].text, /21 executed/);
    assert.equal(testResult.details.pipeline.exitedPlayMode, true, "Connected tests retain their verified Play Mode exit path.");
    assert.equal(testResult.details.pipeline.playModeHandling, "agent_exited");
    assert.equal(JSON.stringify(testResult).includes("Passing.Record"), false, "Registered tool results must not retain passing test records.");
    assert.equal(dispatched.filter((command) => command === "editor_stop").length, 2);
    assert.equal(dispatched.filter((command) => command === "recompile").length, 1);
    assert.equal(dispatched.filter((command) => command === "run_tests").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
{
  const root = await mkdtemp(join(tmpdir(), "pi-unity-native-failure-"));
  try {
    await mkdir(join(root, "ProjectSettings"));
    await mkdir(join(root, "Packages"));
    await writeFile(join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.0f1\n");
    await writeFile(join(root, "Packages", "manifest.json"), '{"dependencies":{"com.unity.pipeline":"0.3.0-exp.1"}}');
    const project = await realpath(root);
    const ctx = { cwd: project, sessionManager: {}, mode: "print", hasUI: false, ui: {} };
    for (const name of ["unity_pipeline_eval", "unity_pipeline_inspect"]) {
      for (const scenario of ["success", "identity", "unadvertised", "dispatch-failed", "timeout", "thrown-timeout", "malformed", "reported-failure"]) {
        const calls: string[][] = [];
        let discoveries = 0;
        const command = name === "unity_pipeline_eval" ? "eval" : "get_authoring_root";
        const pi = fakePi(async (_command, args) => {
          calls.push(args);
          if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
          if (args.includes("pipeline") && args.includes("list")) {
            discoveries++;
            return { code: 0, stdout: JSON.stringify({ success: true, data: { instances: [{ projectPath: project, pid: scenario === "identity" && discoveries > 1 ? 43 : 42, pipelineServer: { isReachable: true } }] } }), stderr: "" };
          }
          if (args.includes("list")) return { code: 0, stdout: JSON.stringify({ success: true, data: { commands: scenario === "unadvertised" ? ["editor_status"] : [command] } }), stderr: "" };
          assert.equal(args[args.indexOf("--timeout") + 2], command, "Only the selected command may dispatch.");
          if (scenario === "dispatch-failed") return { code: 1, stdout: "", stderr: "Synthetic dispatch error" };
          if (scenario === "timeout") return { code: null, killed: true, stdout: "", stderr: "" };
          if (scenario === "thrown-timeout") throw Object.assign(new Error("Synthetic timeout"), { code: "ETIMEDOUT" });
          if (scenario === "malformed") return { code: 0, stdout: "not JSON", stderr: "" };
          if (scenario === "reported-failure") return { code: 0, stdout: JSON.stringify({ success: true, data: { success: false, result: { success: false, diagnostics: [{ severity: "Error", message: "Synthetic diagnostic" }] } } }), stderr: "" };
          return { code: 0, stdout: JSON.stringify({ success: true, data: { result: { success: true, result: 42, diagnostics: [] } } }), stderr: "" };
        });
        registerUnity(pi as any);
        const tool = pi.tools.find(item => item.name === name);
        const result = await nativeToolResult(pi, tool, { path: project, ...(command === "eval" ? { code: "return 42;", timeoutSeconds: 12 } : { command }) }, ctx);
        assert.equal(result.isError, scenario !== "success", `${name}/${scenario} native failure`);
        const detail = command === "eval" ? result.details.pipelineEval : result.details.pipelineInspection;
        assert.equal(detail.outcome, scenario === "success" ? "dispatched" : "rejected");
        const expectedCode = { identity: "unity_project_identity_changed", unadvertised: "planning_command_unadvertised", "dispatch-failed": "planning_command_failed", timeout: "planning_command_timeout", "thrown-timeout": "planning_command_timeout", malformed: "planning_command_malformed", "reported-failure": "planning_command_reported_failure" }[scenario];
        if (expectedCode) assert.equal(detail.code, expectedCode, `${name}/${scenario} structured reason`);
        if (["timeout", "thrown-timeout", "dispatch-failed"].includes(scenario)) assert.match(detail.message, /effect may be uncertain/, "Failure after dispatch never implies no mutation occurred.");
        if (scenario === "reported-failure") assert.match(detail.message, /Synthetic diagnostic/);
        const dispatches = calls.filter(args => args.includes("command") && !args.includes("list"));
        assert.equal(dispatches.length, ["identity", "unadvertised"].includes(scenario) ? 0 : 1, `${name}/${scenario}: zero retry or fallback`);
        assert(calls.every(args => !args.some(arg => ["open", "run", "test", "Exit", "editor_stop"].includes(arg))), "No lifecycle, launch, test or fallback commands.");
      }
    }
    const pi = fakePi();
    registerUnity(pi as any);
    const hook = pi.handlers.get("tool_result")![0];
    const rejection = { mode: "pipeline_eval", pipelineEval: { outcome: "rejected", code: "synthetic", message: "synthetic" } };
    assert.equal(await hook({ toolName: "unrelated_tool", details: rejection, isError: false }, ctx), undefined, "Other tools are not classified by Unity-shaped content.");
    assert.equal(await hook({ toolName: "unity_pipeline_eval", details: { ...rejection, mode: "unrelated" }, isError: false }, ctx), undefined);
    assert.equal(await hook({ toolName: "unity_pipeline_eval", details: undefined, isError: true }, ctx), undefined, "Existing thrown failures are never cleared.");
  } finally { await rm(root, { recursive: true, force: true }); }
}
{
  const root = await mkdtemp(join(tmpdir(), "pi-unity-artifact-contract-"));
  try {
    await mkdir(join(root, "ProjectSettings"));
    await mkdir(join(root, "Packages"));
    await mkdir(join(root, "Logs"));
    await writeFile(join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.0f1\n");
    await writeFile(join(root, "Packages", "manifest.json"), '{"dependencies":{}}');
    let dispatches = 0;
    const pi = fakePi(async () => { dispatches++; throw new Error("Artifact inspection must not execute Unity"); });
    registerUnity(pi as any);
    const tool = pi.tools.find(item => item.name === "unity_inspect_artifacts");
    const ctx = { cwd: root, sessionManager: {}, mode: "print", hasUI: false, ui: {} };
    const inspect = (params: any) => tool.execute("artifacts", { path: root, ...params }, undefined, undefined, ctx);
    const base: NormalizedUnityTestResult = {
      schemaVersion: 1, source: "pipeline", platform: "EditMode", selection: { testFilters: ["Synthetic.Suite"], testCategories: [] },
      outcome: "passed", summary: { total: 2, passed: 2, failed: 0 }, tests: [{ name: "Synthetic.One", status: "Passed" }],
    };
    const artifact = async (result: NormalizedUnityTestResult) => writeNormalizedUnityTestArtifact(root, result);
    const passing = await artifact(base);
    const latest = await inspect({});
    assert.equal(latest.details.testOutcome, "passed", "JSON-only discovery is first-class inspection input.");
    assert.match(latest.content[0].text, /does not establish current-run identity/);
    const flaky = await artifact({ ...base, outcome: "passed_with_flakes", flakyTests: [{ name: "Synthetic.One", attempts: 2 }] });
    assert.equal((await inspect({ normalizedResultPath: flaky })).details.testOutcome, "passed_with_flakes");
    // Existing unrelated latest XML/logs must not be selected for an exact JSON request.
    await writeFile(join(root, "Logs", "unrelated.xml"), '<test-run total="1" passed="0" failed="1"></test-run>');
    await writeFile(join(root, "Logs", "unrelated.log"), "Synthetic previous run log");
    const success = await inspect({ normalizedResultPath: passing });
    assert.equal(success.details.status, "passed");
    assert.equal(success.details.testOutcome, "passed");
    assert.equal(success.details.normalizedResult.testRecordCount, 1, "Bounded records need not equal total.");
    assert.equal(success.details.normalizedResult.tests, undefined, "Routine output must not retain all records.");
    assert.equal(success.details.artifacts.testResultsPath, undefined, "Explicit request disables unrelated latest XML.");
    assert.equal(success.details.artifacts.logFilePath, undefined);
    const failed = await artifact({ ...base, outcome: "tests_failed", summary: { total: 1, passed: 0, failed: 1 }, tests: [{ name: "Synthetic.Failing", status: "Failed", message: "Synthetic assertion mismatch" }] });
    const failure = await inspect({ normalizedResultPath: failed, latestFromLogs: false });
    assert.equal(failure.details.status, "passed", "Successful inspection is not a passing test run.");
    assert.equal(failure.details.testOutcome, "tests_failed");
    assert.match(failure.content[0].text, /Synthetic assertion mismatch/);
    for (const outcome of ["uncertain", "timed_out", "cancelled", "run_error", "empty_selection"] as const) {
      const zero = await artifact({ ...base, outcome, summary: { total: 0, passed: 0, failed: 0 }, tests: [] });
      const result = await inspect({ normalizedResultPath: zero });
      assert.equal(result.details.status, "passed", outcome);
      assert.equal(result.details.testOutcome, outcome, "Valid uncertainty/empty evidence never becomes passing tests.");
    }
    const unknown = await artifact({ ...base, outcome: "uncertain", summary: {}, tests: [] });
    assert.equal((await inspect({ normalizedResultPath: unknown })).details.testOutcome, "uncertain", "Schema-v1 counts are optional, not invented.");
    for (const [label, value] of [
      ["malformed", "{"], ["null", "null"], ["partial", { schemaVersion: 1, outcome: "passed" }],
      ["schema", { ...base, schemaVersion: 2 }], ["source", { ...base, source: "unknown" }],
      ["platform", { ...base, platform: "Unknown" }], ["outcome", { ...base, outcome: "ok" }],
      ["selection", { ...base, selection: {} }], ["records", { ...base, tests: [null] }],
      ["zero-pass", { ...base, summary: { total: 0, passed: 0, failed: 0 }, tests: [] }],
      ["unknown-pass", { ...base, summary: {}, tests: [] }],
      ["inconsistent", { ...base, summary: { total: 1, passed: 2, failed: 0 } }],
      ["fractional", { ...base, summary: { total: 1.5, passed: 1.5, failed: 0 } }],
      ["negative", { ...base, summary: { total: 2, passed: 2, failed: -1 } }],
      ["record-conflict", { ...base, tests: [{ name: "Synthetic.Failing", status: "Failed" }] }],
      ["identity", { ...base, backendArtifacts: { nunit: "../other/results.xml" } }],
      ["timestamp", { ...base, completedAt: "not-a-date" }],
    ] as const) {
      const file = join(root, "Logs", `${label}.json`);
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
      await assert.rejects(() => inspect({ normalizedResultPath: file }), /could not be loaded\/validated/, label);
    }
    for (const key of ["normalizedResultPath", "testResultsPath", "logFilePath"]) {
      await assert.rejects(() => inspect({ [key]: "Logs/missing-evidence", ...(key === "normalizedResultPath" ? {} : { normalizedResultPath: passing }) }), /missing-evidence/, `Missing explicit ${key} must not be masked by valid other evidence.`);
    }
    await assert.rejects(() => inspect({ latestFromLogs: false }), /No valid Unity artifacts/);
    const xmlPath = join(root, "Logs", "exact.xml");
    await writeFile(xmlPath, '<test-run total="2" passed="2" failed="0"></test-run>');
    const linked = await artifact({ ...base, source: "unity-cli", backendArtifacts: { nunit: "Logs/exact.xml" } });
    const mixed = await inspect({ normalizedResultPath: linked, testResultsPath: xmlPath });
    assert.equal(mixed.details.testOutcome, "passed", "Matching linked native evidence is supported.");
    const uncorrelated = await inspect({ normalizedResultPath: passing, testResultsPath: xmlPath });
    assert.equal(uncorrelated.details.testOutcome, "uncertain", "Matching counts alone do not establish shared run identity.");
    assert.match(uncorrelated.content[0].text, /no shared run identity/);
    await assert.rejects(() => inspect({ normalizedResultPath: linked, testResultsPath: "Logs/unrelated.xml" }), /Conflicting/);
    await writeFile(join(root, "Logs", "different-run.xml"), '<test-run total="2" passed="2" failed="0"></test-run>');
    await assert.rejects(() => inspect({ normalizedResultPath: linked, testResultsPath: "Logs/different-run.xml" }), /Conflicting artifact identity/, "Identical counts must not mask an explicit run path mismatch.");
    await writeFile(xmlPath, '<test-run total="1" passed="2" failed="0"></test-run>');
    await assert.rejects(() => inspect({ testResultsPath: xmlPath }), /inconsistent counts/);
    await writeFile(xmlPath, '<test-run total="2" passed="1" failed="1"></test-run>');
    await assert.rejects(() => inspect({ normalizedResultPath: linked, testResultsPath: xmlPath }), /Conflicting normalized\/XML/);
    const xmlFailure = await inspect({ testResultsPath: xmlPath });
    assert.equal(xmlFailure.details.status, "passed");
    assert.equal(xmlFailure.details.testOutcome, "tests_failed");
    const logOnly = await inspect({ logFilePath: "Logs/unrelated.log" });
    assert.equal(logOnly.details.status, "passed");
    assert.equal(logOnly.details.testOutcome, undefined, "A loaded log alone is not test evidence.");
    assert.equal(dispatches, 0, "All artifact cases are read-only and offline.");
  } finally { await rm(root, { recursive: true, force: true }); }
}
console.log("pi-unity reverse load-order, result-contract and delayed-shutdown registration tests passed");

{
  const warningSymbol = Symbol.for("@aefree/pi-unity/unity-cli-warning/v1");
  const resetWarning = () => { delete (globalThis as Record<PropertyKey, unknown>)[warningSymbol]; };
  const createUiContext = (hasUI = true) => {
    const notifications: string[] = [];
    return {
      notifications,
      ctx: { cwd: process.cwd(), sessionManager: {}, mode: hasUI ? "tui" : "print", hasUI, ui: { setStatus() {}, notify(message: string) { notifications.push(message); } } },
    };
  };

  try {
    resetWarning();
    const unavailable = createUiContext();
    const unity = fakePi(async () => ({ code: 1, stdout: "", stderr: "invalid configured CLI" }));
    registerUnity(unity as any);
    await emit(unity, "session_start", unavailable.ctx);
    await emit(unity, "session_start", { ...unavailable.ctx, sessionManager: {} });
    assert.equal(unavailable.notifications.length, 1, "Unavailable Unity CLI warns once per runtime across session scopes.");
    assert.match(unavailable.notifications[0] ?? "", /Unity CLI/i);
    assert.match(unavailable.notifications[0] ?? "", /restart or reload Pi/i);
    assert.equal(unavailable.notifications[0]?.includes(process.cwd()), false, "Capability warning must not expose a configured local path.");

    resetWarning();
    const successful = createUiContext();
    const successfulPi = fakePi(async () => ({ code: 0, stdout: "1.0.0", stderr: "" }));
    registerUnity(successfulPi as any);
    await emit(successfulPi, "session_start", successful.ctx);
    assert.equal(successful.notifications.length, 0, "A successful Unity CLI probe must not warn.");

    resetWarning();
    const timedOut = createUiContext();
    const timedOutPi = fakePi(async () => ({ code: null, killed: true, stdout: "", stderr: "" }));
    registerUnity(timedOutPi as any);
    await emit(timedOutPi, "session_start", timedOut.ctx);
    assert.equal(timedOut.notifications.length, 0, "A timed-out Unity CLI probe must not warn.");

    resetWarning();
    const timedOutError = createUiContext();
    const timedOutErrorPi = fakePi(async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); });
    registerUnity(timedOutErrorPi as any);
    await emit(timedOutErrorPi, "session_start", timedOutError.ctx);
    assert.equal(timedOutError.notifications.length, 0, "A rejected timed-out Unity CLI probe must not warn.");

    resetWarning();
    const cancelled = createUiContext();
    const cancelledPi = fakePi(async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); });
    registerUnity(cancelledPi as any);
    await emit(cancelledPi, "session_start", cancelled.ctx);
    assert.equal(cancelled.notifications.length, 0, "A cancelled Unity CLI probe must not warn.");

    resetWarning();
    const noUi = createUiContext(false);
    let noUiProbeCount = 0;
    const noUiPi = fakePi(async () => { noUiProbeCount += 1; return { code: 1, stdout: "", stderr: "" }; });
    registerUnity(noUiPi as any);
    await emit(noUiPi, "session_start", noUi.ctx);
    assert.equal(noUiProbeCount, 0, "Headless sessions must not run the startup warning probe.");

    resetWarning();
    const configured = createUiContext();
    const configuredPath = "C:/private/unity-cli";
    const originalCliPath = process.env.UNITY_CLI_PATH;
    process.env.UNITY_CLI_PATH = configuredPath;
    try {
      const configuredPi = fakePi(async () => ({ code: 1, stdout: "", stderr: "invalid configured CLI" }));
      registerUnity(configuredPi as any);
      await emit(configuredPi, "session_start", configured.ctx);
      assert.equal(configured.notifications[0]?.includes(configuredPath), false, "Capability warning must not expose UNITY_CLI_PATH.");
    } finally {
      if (originalCliPath === undefined) delete process.env.UNITY_CLI_PATH;
      else process.env.UNITY_CLI_PATH = originalCliPath;
    }
  } finally {
    resetWarning();
  }
}
