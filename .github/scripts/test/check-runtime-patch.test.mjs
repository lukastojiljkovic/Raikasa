// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SCRIPTS, removeTree } from "./helpers.mjs";

function check(files, extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-patch-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
    const args = extraArgs.map((arg) => (arg.startsWith("@") ? join(dir, arg.slice(1)) : arg));
    const result = spawnSync(process.execPath, [join(SCRIPTS, "check-runtime-patch.mjs"), ...args], { encoding: "utf8" });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  } finally {
    removeTree(dir);
  }
}

const index = (latest) => ({ "channel-version": "10.0", "latest-runtime": latest, "latest-sdk": "10.0.404" });
const deps = (version) => ({ libraries: { [`runtimepack.Microsoft.NETCore.App.Runtime.win-x64/${version}`]: { type: "runtimepack" }, "Other/1.0.0": {} } });
const assets = (version) => ({
  project: { frameworks: { "net10.0-windows10.0.26100.0": { downloadDependencies: [{ name: "Microsoft.NETCore.App.Runtime.win-x64", version: `[${version}, ${version}]` }, { name: "Other", version: "[9.9.9, 9.9.9]" }] } } },
});

test("the newest patch in the publish folder's deps.json passes", () => {
  const r = check({ "app.deps.json": deps("10.0.15"), "index.json": index("10.0.15") }, ["--deps", "@app.deps.json", "--index", "@index.json"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /newest 10\.0 patch/);
});

test("an older patch fails and names both versions and the remedy", () => {
  const r = check({ "app.deps.json": deps("10.0.14"), "index.json": index("10.0.15") }, ["--deps", "@app.deps.json", "--index", "@index.json"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /bundled runtime is 10\.0\.14/);
  assert.match(r.out, /newest 10\.0 patch is 10\.0\.15/);
  assert.match(r.out, /global\.json/);
});

test("the restore result's download dependency is read too", () => {
  const ok = check({ "project.assets.json": assets("10.0.15"), "index.json": index("10.0.15") }, ["--assets", "@project.assets.json", "--index", "@index.json"]);
  assert.equal(ok.status, 0, ok.out);
  const stale = check({ "project.assets.json": assets("10.0.13"), "index.json": index("10.0.15") }, ["--assets", "@project.assets.json", "--index", "@index.json"]);
  assert.equal(stale.status, 1, stale.out);
});

test("a patch numbered higher than the index is not accepted either", () => {
  const r = check({ "app.deps.json": deps("10.0.16"), "index.json": index("10.0.15") }, ["--deps", "@app.deps.json", "--index", "@index.json"]);
  assert.equal(r.status, 1, r.out);
});

test("a missing runtime pack, a missing latest-runtime and a missing file are errors, never a pass", () => {
  const none = check({ "app.deps.json": { libraries: {} }, "index.json": index("10.0.15") }, ["--deps", "@app.deps.json", "--index", "@index.json"]);
  assert.equal(none.status, 2, none.out);
  const noLatest = check({ "app.deps.json": deps("10.0.15"), "index.json": {} }, ["--deps", "@app.deps.json", "--index", "@index.json"]);
  assert.equal(noLatest.status, 2, noLatest.out);
  const otherChannel = check({ "app.deps.json": deps("10.0.15"), "index.json": index("9.0.9") }, ["--deps", "@app.deps.json", "--index", "@index.json"]);
  assert.equal(otherChannel.status, 2, otherChannel.out);
  const missing = check({ "index.json": index("10.0.15") }, ["--deps", "@absent.json", "--index", "@index.json"]);
  assert.equal(missing.status, 2, missing.out);
  const both = check({ "a.json": deps("10.0.15"), "index.json": index("10.0.15") }, ["--deps", "@a.json", "--assets", "@a.json", "--index", "@index.json"]);
  assert.equal(both.status, 2, both.out);
});
