import { isAbsolute } from "node:path";
import { determineUnityTestOutcome, type NormalizedUnityTestResult } from "./unity-tests";

const outcomes = ["passed", "passed_with_flakes", "tests_failed", "empty_selection", "run_error", "timed_out", "cancelled", "uncertain"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && !!item.trim() && !/[\0\r\n;]/.test(item));
const relativeId = (value: unknown): value is string => typeof value === "string" && !!value.trim()
  && !isAbsolute(value) && !/^(?:[A-Za-z]:|[\\/])/.test(value) && !value.split(/[\\/]/).includes("..") && !/\0/.test(value);

/** Read the durable schema, not a transport response. Missing optional counts remain unknown.
 * Test records may be bounded or absent: never require tests.length === summary.total.
 */
export function validateNormalizedUnityTestArtifact(value: unknown): NormalizedUnityTestResult {
  const invalid = (reason: string): never => { throw new Error(`Invalid normalized Unity test artifact: ${reason}.`); };
  if (!record(value) || value.schemaVersion !== 1) invalid("expected schemaVersion 1 object");
  const result = value as Record<string, unknown>;
  if (!["pipeline", "unity-cli", "editor-executable"].includes(result.source as string)) invalid("unsupported source");
  if (!["EditMode", "PlayMode"].includes(result.platform as string)) invalid("unsupported platform");
  if (!outcomes.includes(result.outcome as string)) invalid("unsupported outcome");
  if (!record(result.selection) || !strings(result.selection.testFilters) || !strings(result.selection.testCategories)) invalid("selection must contain testFilters and testCategories arrays");
  if (!record(result.summary)) invalid("summary must be an object");
  const summary = result.summary as Record<string, unknown>;
  for (const key of ["total", "passed", "failed", "skipped", "inconclusive"]) {
    if (summary[key] !== undefined && !count(summary[key])) invalid(`summary.${key} must be a non-negative integer`);
  }
  if (count(summary.total)) {
    const accounted = [summary.passed, summary.failed, summary.skipped, summary.inconclusive].reduce<number>((sum, item) => sum + (count(item) ? item : 0), 0);
    if (accounted > summary.total) invalid("summary counts exceed total");
  }
  if (!Array.isArray(result.tests)) invalid("tests must be an array");
  const tests = result.tests as unknown[];
  for (const test of tests) {
    if (!record(test) || typeof test.name !== "string" || !test.name.trim() || typeof test.status !== "string" || !test.status.trim()) invalid("test records require name and status");
    const item = test as Record<string, unknown>;
    for (const key of ["message", "stackTrace"]) if (item[key] !== undefined && typeof item[key] !== "string") invalid(`test ${key} must be a string`);
    if (item.durationSeconds !== undefined && !nonnegative(item.durationSeconds)) invalid("test durationSeconds must be non-negative");
    if (item.attempts !== undefined && (!count(item.attempts) || item.attempts < 1)) invalid("test attempts must be positive");
  }
  if (count(summary.total) && tests.length > summary.total) invalid("test records exceed total");
  const typed = result as unknown as NormalizedUnityTestResult;
  for (const [status, key] of [["passed", "passed"], ["failed", "failed"], ["skipped", "skipped"], ["inconclusive", "inconclusive"]] as const) {
    const observed = typed.tests.filter(test => test.status.toLowerCase() === status).length;
    if (count(summary[key]) && observed > summary[key]) invalid(`test records conflict with summary.${key}`);
  }
  if (result.projectRelativeId !== undefined && !relativeId(result.projectRelativeId)) invalid("projectRelativeId must be project-relative");
  if (result.backendArtifacts !== undefined && (!record(result.backendArtifacts) || !Object.values(result.backendArtifacts).every(relativeId))) invalid("backendArtifacts must contain project-relative paths");
  for (const key of ["startedAt", "completedAt"]) if (result[key] !== undefined && (typeof result[key] !== "string" || !Number.isFinite(Date.parse(result[key] as string)))) invalid(`${key} must be a timestamp`);
  if (typed.startedAt && typed.completedAt && Date.parse(typed.completedAt) < Date.parse(typed.startedAt)) invalid("completion precedes start");
  if (result.durationSeconds !== undefined && !nonnegative(result.durationSeconds)) invalid("durationSeconds must be non-negative");
  if (result.flakyTests !== undefined && (!Array.isArray(result.flakyTests) || !result.flakyTests.every(item => record(item) && typeof item.name === "string" && !!item.name.trim() && count(item.attempts) && item.attempts > 0))) invalid("invalid flakyTests");
  if (result.outcome === "passed" || result.outcome === "passed_with_flakes") {
    if (determineUnityTestOutcome(typed.summary) !== "passed" || typed.tests.some(test => !["passed", "success"].includes(test.status.toLowerCase()))) invalid("passing outcome lacks consistent positive passing counts/records");
    if (result.outcome === "passed_with_flakes" && !typed.flakyTests?.length) invalid("passed_with_flakes requires flakyTests evidence");
  }
  if (result.outcome === "empty_selection" && ((typed.summary.total ?? 0) > 0 || tests.length > 0)) invalid("empty selection conflicts with executed tests");
  return typed;
}
