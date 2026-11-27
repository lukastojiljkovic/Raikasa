// SPDX-License-Identifier: MIT
// The mutation gate decides whether a pull request or a night is green, so it is held
// to the rule it enforces: every case below names the break it catches.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeRepo, run } from "./helpers.mjs";

function workdir(files) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const stryker = (statuses) =>
  JSON.stringify({
    schemaVersion: "2",
    thresholds: { high: 100, low: 80 },
    files: { "src/a.ts": { language: "typescript", source: "", mutants: statuses.map((status, i) => ({ id: String(i), mutatorName: "x", status, location: {} })) } },
  });

function score(files, args) {
  const dir = workdir(files);
  const out = join(dir, "github-output.txt");
  writeFileSync(out, "");
  const r = run("mutation-gate.mjs", ["score", ...args], dir, { GITHUB_OUTPUT: out });
  const outputs = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { ...r, outputs };
}

test("Stryker: killed and timed-out mutants are detected; survivors and uncovered ones are not", () => {
  // 3 detected (Killed, Killed, Timeout) of 4 judged (+ Survived); NoCoverage counts
  // as undetected, CompileError and Ignored are not judged: 3 of 5 = 60%.
  const r = score({ "r.json": stryker(["Killed", "Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "Ignored"]) }, ["--format", "stryker", "--report", "r.json", "--min", "60"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /detected 3 of 5 mutants: 60\.0%/);
});

test("a score below the minimum fails", () => {
  const r = score({ "r.json": stryker(["Killed", "Survived"]) }, ["--format", "stryker", "--report", "r.json", "--min", "80"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /below 80%/);
});

test("a report with no judged mutant is not 100%, and no flag turns it into a pass", () => {
  // Round 2 (R2-B4): a blanket --allow-empty with a wrong module name would let every
  // pull request pass with nothing measured, so the flag is gone; an empty result
  // passes only through a format's own proof (mutmut-meta, pit with --changed).
  const files = { "r.json": stryker(["CompileError"]) };
  assert.equal(score(files, ["--format", "stryker", "--report", "r.json", "--min", "80"]).code, 2);
  assert.notEqual(score(files, ["--format", "stryker", "--report", "r.json", "--min", "80", "--allow-empty"]).code, 0);
});

test("a missing report is an error, never a pass", () => {
  const r = score({}, ["--format", "stryker", "--report", "nowhere.json", "--min", "80"]);
  assert.equal(r.code, 2, r.out);
});

test("cargo-mutants: caught and timeout of caught, timeout and missed", () => {
  const outcomes = JSON.stringify({ total_mutants: 12, caught: 7, timeout: 1, missed: 2, unviable: 2, success: 0 });
  const r = score({ "mutants.out/outcomes.json": outcomes }, ["--format", "cargo-mutants", "--report", "mutants.out/outcomes.json", "--min", "80"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /detected 8 of 10 mutants: 80\.0%/);
});

test("mutmut: killed and timeout of everything judged, as the export counts it", () => {
  const stats = JSON.stringify({ killed: 6, survived: 1, total: 40, no_tests: 1, skipped: 30, suspicious: 0, timeout: 1, check_was_interrupted_by_user: 0, segfault: 1 });
  const r = score({ "mutants/mutmut-cicd-stats.json": stats }, ["--format", "mutmut", "--report", "mutants/mutmut-cicd-stats.json", "--min", "80"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /detected 7 of 10 mutants: 70\.0%/);
});

test("PIT: every mutations.xml under a directory, NON_VIABLE and RUN_ERROR not judged", () => {
  const xml = (statuses) => `<?xml version="1.0"?><mutations>${statuses.map((s) => `<mutation detected="${s === "KILLED" || s === "TIMED_OUT"}" status="${s}"><sourceFile>A.kt</sourceFile></mutation>`).join("")}</mutations>`;
  const r = score(
    {
      "build/reports/pitest/core/mutations.xml": xml(["KILLED", "TIMED_OUT", "SURVIVED"]),
      "build/reports/pitest/proto/mutations.xml": xml(["KILLED", "NO_COVERAGE", "NON_VIABLE", "RUN_ERROR"]),
    },
    ["--format", "pit", "--report", "build/reports/pitest", "--min", "60"],
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /detected 3 of 5 mutants: 60\.0%/);
});

test("the nightly gate reads its threshold from the one ratchet file, by key", () => {
  const files = { "r.json": stryker(["Killed", "Killed", "Killed", "Survived"]), ".github/mutation-ratchet.json": '{ "percent": 75, "python": 90 }\n' };
  assert.equal(score(files, ["--format", "stryker", "--report", "r.json", "--ratchet", ".github/mutation-ratchet.json"]).code, 0);
  const r = score(files, ["--format", "stryker", "--report", "r.json", "--ratchet", ".github/mutation-ratchet.json", "--key", "python"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ratchet 90%/);
});

test("the measured score and its floor reach the workflow outputs", () => {
  const r = score({ "r.json": stryker(["Killed", "Killed", "Survived"]) }, ["--format", "stryker", "--report", "r.json", "--min", "50"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.outputs, /^score=66\.6$/m);
  assert.match(r.outputs, /^floor=66$/m);
  assert.match(r.outputs, /^threshold=50$/m);
});

// ---- Pull requests that change no mutable code (round 2, R2-B4) ------------------
//
// mutmut 3.8.1 records every source file it processed in mutants/<path>.meta, whose
// exit_code_by_key maps each mutant to its exit code (null until it ran;
// src/mutmut/mutation/data.py). A file with no function has no key.

const meta = (codes) => JSON.stringify({ exit_code_by_key: codes, hash_by_function_name: {}, durations_by_key: {}, estimated_durations_by_key: {}, type_check_error_by_key: {} });

function gate(files, args) {
  const dir = workdir(files);
  const r = run("mutation-gate.mjs", args, dir);
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test("mutmut patterns: a module, a package's __init__ and a top-level module, by mutmut's own naming", () => {
  const r = gate({ "changed.txt": "src/pkg/sub/mod.py\nsrc/pkg/__init__.py\nsrc/top.py\n" }, ["patterns", "--format", "mutmut", "--changed", "changed.txt"]);
  assert.equal(r.code, 0, r.out);
  const lines = r.out.trim().split(/\r?\n/).filter(Boolean);
  // pkg.sub.mod.* and not pkg.sub.mod*, which would also select pkg.sub.module_b.
  assert.deepEqual(lines.sort(), ["pkg.sub.mod.*", "pkg.x_*", "pkg.xǁ*", "top.*"].sort());
});

test("mutmut patterns: a path outside src/ is an error, not a silent pattern", () => {
  const r = gate({ "changed.txt": "lib/pkg/mod.py\n" }, ["patterns", "--format", "mutmut", "--changed", "changed.txt"]);
  assert.equal(r.code, 2, r.out);
});

test("mutmut-meta: scores only the changed files, with mutmut's exit-code meanings", () => {
  // a.py: killed (1), killed (3), survived (0), timeout (36), no tests (33), skipped (34,
  // not judged), caught by the type checker (37, not judged): 3 of 5 = 60%.
  // other.py is not in the pull request and its survivor must not count.
  const r = score(
    {
      "changed.txt": "src/pkg/a.py\n",
      "mutants/src/pkg/a.py.meta": meta({ "pkg.a.x_f__mutmut_1": 1, "pkg.a.x_f__mutmut_2": 3, "pkg.a.x_f__mutmut_3": 0, "pkg.a.x_f__mutmut_4": 36, "pkg.a.x_f__mutmut_5": 33, "pkg.a.x_f__mutmut_6": 34, "pkg.a.x_f__mutmut_7": 37 }),
      "mutants/src/pkg/other.py.meta": meta({ "pkg.other.x_g__mutmut_1": 0 }),
    },
    ["--format", "mutmut-meta", "--report", "mutants", "--changed", "changed.txt", "--min", "60"],
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /detected 3 of 5 mutants: 60\.0%/);
});

test("mutmut-meta: a changed file with no mutant at all is no mutable code, and passes", () => {
  const r = score({ "changed.txt": "src/pkg/constants.py\n", "mutants/src/pkg/constants.py.meta": meta({}) }, ["--format", "mutmut-meta", "--report", "mutants", "--changed", "changed.txt", "--min", "80"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no mutable code/i);
});

test("mutmut-meta: mutants generated but never run mean a wrong pattern, and fail", () => {
  const r = score({ "changed.txt": "src/pkg/a.py\n", "mutants/src/pkg/a.py.meta": meta({ "pkg.a.x_f__mutmut_1": null, "pkg.a.x_f__mutmut_2": null }) }, ["--format", "mutmut-meta", "--report", "mutants", "--changed", "changed.txt", "--min", "80"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /src\/pkg\/a\.py/);
});

test("mutmut-meta: a changed file mutmut never processed fails, even beside a measured one", () => {
  const r = score(
    { "changed.txt": "src/pkg/a.py\nsrc/pkg/b.py\n", "mutants/src/pkg/a.py.meta": meta({ "pkg.a.x_f__mutmut_1": 1 }) },
    ["--format", "mutmut-meta", "--report", "mutants", "--changed", "changed.txt", "--min", "80"],
  );
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /src\/pkg\/b\.py: mutmut did not process it/);
});

test("mutmut-meta needs --changed: without the list there is nothing to prove", () => {
  const r = score({ "mutants/src/pkg/a.py.meta": meta({ "pkg.a.x_f__mutmut_1": 1 }) }, ["--format", "mutmut-meta", "--report", "mutants", "--min", "80"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--changed/);
});

// PIT 1.30.2 with failWhenNoMutations=false returns before its analysis when it finds
// no mutation, so it writes no mutations.xml at all (MutationCoverage.java, lines
// 133-139); it logs "no mutations found". The proof is therefore the log plus the
// changed file's classes existing in the module's compiled output.

const kotlinRootOmitted = "package org.example.app.net\n\n@file:Suppress(\"unused\")\n\nconst val VERSION = 2\n\nsealed interface Message\n\ndata class Hello(val id: Int) : Message\n\nfun encode(m: Message): ByteArray = TODO()\n";

test("PIT targets come from the package line, not the folder (Kotlin omits the common root package)", () => {
  // core/src/main/kotlin/net/Wire.kt declares package org.example.app.net, so the old
  // path-derived name "net.Wire*" named classes that do not exist (round 2, N30).
  const r = gate({ "changed.txt": "core/src/main/kotlin/net/Wire.kt\n", "core/src/main/kotlin/net/Wire.kt": kotlinRootOmitted }, ["patterns", "--format", "pit", "--changed", "changed.txt"]);
  assert.equal(r.code, 0, r.out);
  const targets = r.out.trim().split(",");
  for (const t of ["org.example.app.net.WireKt", "org.example.app.net.WireKt$*", "org.example.app.net.Message", "org.example.app.net.Message$*", "org.example.app.net.Hello", "org.example.app.net.Hello$*"]) {
    assert.ok(targets.includes(t), `${t} missing from ${r.out}`);
  }
  assert.ok(!targets.some((t) => t.startsWith("net.")), r.out);
  // Exact names, never a bare prefix such as "Hello*", which would also mutate HelloWorld.
  assert.ok(!targets.includes("org.example.app.net.Hello*"), r.out);
});

test("PIT targets: @file:JvmName names the facade, and Java's package line ends with a semicolon", () => {
  const r = gate(
    {
      "changed.txt": "core/src/main/kotlin/a/Util.kt\ncore/src/main/java/b/Codec.java\n",
      "core/src/main/kotlin/a/Util.kt": '@file:JvmName("Wire")\npackage com.x.a\n\nfun f() = 1\n',
      "core/src/main/java/b/Codec.java": "package com.x.b;\n\npublic final class Codec {\n  static class Inner {}\n}\n",
    },
    ["patterns", "--format", "pit", "--changed", "changed.txt"],
  );
  assert.equal(r.code, 0, r.out);
  const targets = r.out.trim().split(",");
  assert.ok(targets.includes("com.x.a.Wire"), r.out);
  assert.ok(!targets.includes("com.x.a.UtilKt"), r.out);
  assert.ok(targets.includes("com.x.b.Codec") && targets.includes("com.x.b.Codec$*"), r.out);
});

const pitFiles = (extra) => ({
  "changed.txt": "core/src/main/kotlin/net/Wire.kt\n",
  "core/src/main/kotlin/net/Wire.kt": kotlinRootOmitted,
  ...extra,
});

test("PIT: no mutations.xml, PIT said it found none, and the classes exist: no mutable code, passes", () => {
  const r = score(
    pitFiles({
      "pit-reports/core/pitest.log": "PIT >> WARNING : No mutations found. This probably means there is an issue with either the supplied classpath or filters.\n",
      "core/build/classes/kotlin/main/org/example/app/net/Message.class": "x",
      "core/build/classes/kotlin/main/org/example/app/net/WireKt.class": "x",
    }),
    ["--format", "pit", "--report", "pit-reports", "--changed", "changed.txt", "--min", "80"],
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no mutable code/i);
});

test("PIT: classes that do not exist mean wrong target names, and fail", () => {
  const r = score(
    pitFiles({ "pit-reports/core/pitest.log": "No mutations found.\n", "core/build/classes/kotlin/main/net/WireKt.class": "x" }),
    ["--format", "pit", "--report", "pit-reports", "--changed", "changed.txt", "--min", "80"],
  );
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Wire\.kt/);
});

test("PIT: a module PIT did not run for (no log) fails", () => {
  const r = score(pitFiles({ "core/build/classes/kotlin/main/org/example/app/net/WireKt.class": "x" }), ["--format", "pit", "--report", "pit-reports", "--changed", "changed.txt", "--min", "80"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /core/);
});

test("PIT: no report and no 'no mutations found' line fails, whatever the classes", () => {
  const r = score(
    pitFiles({ "pit-reports/core/pitest.log": "BUILD SUCCESSFUL\n", "core/build/classes/kotlin/main/org/example/app/net/WireKt.class": "x" }),
    ["--format", "pit", "--report", "pit-reports", "--changed", "changed.txt", "--min", "80"],
  );
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no mutations found/i);
});

test("PIT with --changed still scores a module that has a report", () => {
  const xml = `<?xml version="1.0"?><mutations><mutation status="KILLED"/><mutation status="KILLED"/><mutation status="KILLED"/><mutation status="KILLED"/><mutation status="SURVIVED"/></mutations>`;
  const r = score(
    pitFiles({ "pit-reports/core/pitest.log": "ok\n", "pit-reports/core/mutations.xml": xml, "core/build/classes/kotlin/main/org/example/app/net/Hello.class": "x" }),
    ["--format", "pit", "--report", "pit-reports", "--changed", "changed.txt", "--min", "80"],
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /detected 4 of 5 mutants: 80\.0%/);
});

function ratchetRepo(baseText, headText) {
  const repo = makeRepo();
  if (baseText !== null) repo.write(".github/mutation-ratchet.json", baseText);
  repo.write("README.md", "x\n");
  const base = repo.commit("chore: base");
  repo.branch("work");
  if (headText === null) rmSync(join(repo.dir, ".github/mutation-ratchet.json"), { force: true });
  else repo.write(".github/mutation-ratchet.json", headText);
  const head = repo.commit("chore: head");
  const r = run("mutation-gate.mjs", ["guard", "--base", base, "--head", head], repo.dir);
  repo.cleanup();
  return r;
}

test("guard: a pull request may raise the ratchet, or leave it as it is", () => {
  assert.equal(ratchetRepo('{ "percent": 80 }\n', '{ "percent": 84 }\n').code, 0);
  assert.equal(ratchetRepo('{ "percent": 80 }\n', '{ "percent": 80 }\n').code, 0);
});

test("guard: a pull request may not lower the ratchet", () => {
  const r = ratchetRepo('{ "percent": 84 }\n', '{ "percent": 80 }\n');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /percent.*84.*80/);
});

test("guard: removing a key or the whole file is lowering it", () => {
  const key = ratchetRepo('{ "percent": 84, "python": 70 }\n', '{ "percent": 84 }\n');
  assert.equal(key.code, 1, key.out);
  assert.match(key.out, /python.*removed/);
  const file = ratchetRepo('{ "percent": 84 }\n', null);
  assert.equal(file.code, 1, file.out);
  assert.match(file.out, /deleted/);
});

test("guard: the first ratchet file is accepted, and its values must be whole percents", () => {
  assert.equal(ratchetRepo(null, '{ "percent": 80 }\n').code, 0);
  for (const bad of ['{ "percent": 80.5 }\n', '{ "percent": 101 }\n']) {
    const r = ratchetRepo(null, bad);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /whole percent/);
  }
});
