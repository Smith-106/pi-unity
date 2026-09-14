import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.env.GITHUB_REF !== "refs/heads/main") {
  console.error(`::error::Trusted publication must be dispatched from main, not ${process.env.GITHUB_REF ?? "unknown"}.`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageName = packageJson.name;
const packageVersion = packageJson.version;
const expectedGitHead = process.env.GITHUB_SHA;
if (typeof packageName !== "string" || packageName.length === 0 || typeof packageVersion !== "string" || packageVersion.length === 0 || typeof expectedGitHead !== "string" || expectedGitHead.length === 0) {
  console.error("::error::Package name, package version, and GITHUB_SHA are required to reconcile the npm release identity.");
  process.exit(1);
}

const packageSpec = `${packageName}@${packageVersion}`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmView = spawnSync(npmCommand, ["view", packageSpec, "version", "gitHead", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (npmView.error) {
  console.error(`::error::Unable to execute npm view for ${packageSpec}: ${npmView.error.message}`);
  process.exit(1);
}

if (npmView.status !== 0) {
  if (npmView.stderr.split(/\r?\n/).includes("npm error code E404")) {
    console.log(`${packageSpec} is not published; continuing.`);
    process.exit(0);
  }

  console.error(`::error::Unable to verify whether ${packageSpec} exists on npm (npm view exited ${npmView.status ?? "without a status"}).`);
  process.stderr.write(npmView.stderr);
  process.exit(npmView.status ?? 1);
}

let metadata;
try {
  metadata = JSON.parse(npmView.stdout);
} catch {
  console.error(`::error::Existing npm metadata for ${packageSpec} is not valid JSON.`);
  process.exit(1);
}

if (
  metadata === null ||
  Array.isArray(metadata) ||
  typeof metadata !== "object" ||
  typeof metadata.version !== "string" ||
  metadata.version.length === 0 ||
  typeof metadata.gitHead !== "string" ||
  metadata.gitHead.length === 0
) {
  console.error(`::error::Existing npm metadata for ${packageSpec} must include non-empty string version and gitHead fields.`);
  process.exit(1);
}

if (metadata.version !== packageVersion || metadata.gitHead !== expectedGitHead) {
  console.error(`::error::Existing npm identity does not match ${packageSpec}: version=${metadata.version}, gitHead=${metadata.gitHead}, expectedVersion=${packageVersion}, expectedGitHead=${expectedGitHead}.`);
  process.exit(1);
}

if (typeof process.env.GITHUB_ENV !== "string" || process.env.GITHUB_ENV.length === 0) {
  console.error("::error::GITHUB_ENV is required to skip an already published npm release.");
  process.exit(1);
}
appendFileSync(process.env.GITHUB_ENV, "SKIP_NPM_PUBLISH=true\n");
console.log(`${packageSpec} already matches ${expectedGitHead}; nothing to publish.`);
