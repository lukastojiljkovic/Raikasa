// SPDX-License-Identifier: MIT
// Stryker refuses its own configuration before a single mutant runs when the
// thresholds are out of order: Stryker.NET 5.0.0 requires break <= low <= high
// (ThresholdBreakInput.cs, ThresholdLowInput.cs), StrykerJS requires low <= high. A
// mutation gate that cannot start is a gate that never fails, so this repository's
// own configuration is checked on every pull request (pr-policy.yml runs this file).
//
// MUTATION_CONFIG_ROOT points the test at another checkout (used to prove it fails).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = process.env.MUTATION_CONFIG_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STRYKER_NET_DEFAULTS = { high: 80, low: 60, break: 0 }; // stryker-mutator.io/docs/stryker-net/configuration

function ordered({ high, low, break: brk }, where) {
  assert.ok(brk <= low, `${where}: break ${brk} is above low ${low}`);
  assert.ok(low <= high, `${where}: low ${low} is above high ${high}`);
  assert.ok(high <= 100 && brk >= 0, `${where}: thresholds are percents`);
}

test("every Stryker configuration file has break <= low <= high", () => {
  for (const name of ["stryker-config.json", "stryker.config.json", "stryker.nightly.config.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    const t = (json["stryker-config"] ?? json).thresholds;
    if (!t) continue; // the nightly configuration takes its thresholds from the ratchet file
    ordered({ ...STRYKER_NET_DEFAULTS, ...t }, name);
  }
});

test("no pull-request mutation gate is set below 80% (section 7.3; round 2, N16)", () => {
  // The order test above lets a pull request lower every number together; this one
  // holds the floor the standard sets.
  for (const name of ["stryker-config.json", "stryker.config.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    const brk = (json["stryker-config"] ?? json).thresholds?.break;
    if (brk !== undefined) assert.ok(brk >= 80, `${name}: break ${brk} is below 80`);
  }
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const m of text.matchAll(/mutation-gate\.mjs score\b[^\n]*?--min[= ]"?(\S+?)"?(?=\s|$)/g)) {
      assert.match(m[1], /^\d+$/, `${name}: --min must be a number, not ${m[1]}`);
      assert.ok(Number(m[1]) >= 80, `${name}: --min ${m[1]} is below 80`);
    }
    for (const m of text.matchAll(/--break-at[= ]"?(\d+)"?/g)) assert.ok(Number(m[1]) >= 80, `${name}: --break-at ${m[1]} is below 80`);
  }
});

// Standard section 11 step 0: Stryker.NET is run with its test runner named explicitly, and its score counts only from
// that runner. Stryker.NET 5.0.0's default runner is VSTest, which does not run an xUnit v3 project; with --since it
// reports "nothing to mutate" only when --test-project is given beside it (B0-U13, 2026-11-25). So every dotnet-stryker
// command names the runner, on its command line or through the --config-file it reads, every command with --since names
// the test project, and stryker-config.json sets "test-runner": "mtp".
test("Stryker.NET runs with its test runner named: --test-runner mtp (or a --config-file that sets it), --test-project beside --since, and test-runner mtp in stryker-config.json (standard 11 step 0; B0-U13)", () => {
  const runnerOf = (name) => {
    const file = join(root, name);
    if (!existsSync(file)) return undefined;
    const json = JSON.parse(readFileSync(file, "utf8"));
    return (json["stryker-config"] ?? json)["test-runner"];
  };
  if (existsSync(join(root, "stryker-config.json"))) assert.equal(runnerOf("stryker-config.json"), "mtp", 'stryker-config.json: "test-runner" must be "mtp"');
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    // Comment lines name the tool too (ThresholdBreakInput.cs at dotnet-stryker@5.0.0); `dotnet tool install` is not a run.
    const text = readFileSync(join(dir, name), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const m of text.matchAll(/(?<!tool install )dotnet-stryker\b[\s\S]*?(?=\n\s*(?:-\s|[a-z-]+:\s)|$)/g)) {
      const cmd = m[0];
      const config = cmd.match(/--config-file[= ]"?([^\s"]+)/)?.[1];
      const named = /--test-runner[= ]"?mtp\b/.test(cmd) || (config !== undefined && runnerOf(config) === "mtp");
      assert.ok(named, `${name}: a dotnet-stryker command does not name its test runner (--test-runner mtp, or a --config-file that sets "test-runner": "mtp"): ${cmd.split("\n")[0]}`);
      if (/--since\b/.test(cmd)) assert.match(cmd, /--test-project[= ]"?\S/, `${name}: a dotnet-stryker command with --since needs --test-project beside it: ${cmd.split("\n")[0]}`);
    }
  }
});

test("every dotnet-stryker command in the workflows gives thresholds in that order", () => {
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(dir, name), "utf8");
    // A command may continue over folded or backslash-continued lines.
    for (const m of text.matchAll(/dotnet-stryker\b[\s\S]*?(?=\n\s*(?:-\s|[a-z-]+:\s)|$)/g)) {
      const cmd = m[0];
      const num = (flag) => cmd.match(new RegExp(`--${flag}[= ]"?(\\d+|\\$\\w+)`))?.[1];
      const brk = num("break-at");
      if (brk === undefined) continue;
      const low = num("threshold-low");
      const high = num("threshold-high");
      assert.ok(low !== undefined && high !== undefined, `${name}: --break-at without --threshold-low and --threshold-high falls back to low 60, high 80`);
      if ([brk, low, high].every((v) => /^\d+$/.test(v))) ordered({ high: +high, low: +low, break: +brk }, name);
      else assert.equal(low, brk, `${name}: a ratchet-driven run passes the same value as --threshold-low and --break-at`);
    }
  }
});
