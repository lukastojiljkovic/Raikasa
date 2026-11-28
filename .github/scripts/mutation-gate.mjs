#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// One mutation gate for every stack, so the score means the same thing everywhere.
//
//   score     reads a mutation tool's report, prints the score and fails below the
//             threshold: --min on pull requests, or the ratchet file at night.
//   patterns  turns a pull request's changed source files into the names the tool
//             selects mutants by: mutmut's module patterns, PIT's target classes.
//   guard     refuses a pull request that lowers the ratchet file or removes a key.
//
// The score is detected / judged. Detected: killed and timed out (Stryker's
// convention). Judged: detected plus the mutants that no test noticed (survived,
// no coverage, no tests). Mutants that never ran (compile errors, unviable, ignored)
// are not judged. A report with nothing judged is exit 2, never 100%.
//
// The one exception is a pull request whose changed files hold no mutable code
// (round 2, R2-B4), and no flag grants it: with --changed, the mutmut-meta and pit
// formats prove it from the tool's own records, file by file, and any changed file
// the tool did not process, or whose mutants were generated but not run (a wrong
// name), fails with exit 2.
//
// Usage:
//   node mutation-gate.mjs score --format stryker|cargo-mutants|mutmut|mutmut-meta|pit --report <file or dir>
//        (--min <percent> | --ratchet .github/mutation-ratchet.json [--key percent]) [--changed <list>]
//   node mutation-gate.mjs patterns --format mutmut|pit --changed <list>
//   node mutation-gate.mjs guard --base <ref> --head <ref> [--file .github/mutation-ratchet.json]
//
// <list> is a file of repository-relative source paths, one per line (git diff
// --name-only). mutmut-meta reads <report>/<path>.meta for each; pit with --changed
// reads <report>/<module>/mutations.xml and pitest.log, and the module's compiled
// classes under <module>/build/classes/{kotlin,java}/main.
//
// The ratchet file is a flat JSON object of whole percents, {"percent": 80}, with one
// key per stack where a repository has two. Outputs for later steps: score (one
// decimal), floor (whole percent, rounded down) and threshold.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

const COUNTERS = {
  // mutation-testing-elements JSON, written by Stryker.NET and StrykerJS.
  stryker(text) {
    const statuses = Object.values(JSON.parse(text).files ?? {}).flatMap((f) => (f.mutants ?? []).map((m) => m.status));
    const n = (...s) => statuses.filter((x) => s.includes(x)).length;
    return { detected: n("Killed", "Timeout"), undetected: n("Survived", "NoCoverage") };
  },
  // cargo-mutants mutants.out/outcomes.json.
  "cargo-mutants"(text) {
    const o = JSON.parse(text);
    return { detected: (o.caught ?? 0) + (o.timeout ?? 0), undetected: o.missed ?? 0 };
  },
  // mutmut export-cicd-stats. "total" also counts mutants outside the run, so it is
  // not used; skipped and interrupted mutants were not judged.
  mutmut(text) {
    const s = JSON.parse(text);
    return {
      detected: (s.killed ?? 0) + (s.timeout ?? 0),
      undetected: (s.survived ?? 0) + (s.no_tests ?? 0) + (s.suspicious ?? 0) + (s.segfault ?? 0),
    };
  },
  // PIT mutations.xml (outputFormats must include XML).
  pit(text) {
    const statuses = [...text.matchAll(/<mutation\b[^>]*\bstatus="([A-Z_]+)"/g)].map((m) => m[1]);
    const n = (...s) => statuses.filter((x) => s.includes(x)).length;
    return { detected: n("KILLED", "TIMED_OUT", "MEMORY_ERROR"), undetected: n("SURVIVED", "NO_COVERAGE") };
  },
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function readList(path) {
  if (!existsSync(path)) fail(2, `the list of changed files ${path} does not exist`);
  return readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ---- mutmut 3.8.1 ----------------------------------------------------------------
//
// A mutant is named <module>.<function>__mutmut_<n>, the module taken from the path
// with "src." stripped and ".__init__." collapsed (src/mutmut/utils/format_utils.py,
// get_mutant_name); a method's function part starts with "xǁ", a function's with "x_".

function mutmutPatterns(path) {
  if (!/^src\/.+\.py$/.test(path)) fail(2, `${path}: mutmut's patterns are built for the src layout (src/<package>/<module>.py)`);
  const module = path.slice("src/".length, -".py".length).split("/").join(".");
  if (module === "__init__") return ["__init__.*"];
  if (module.endsWith(".__init__")) {
    const pkg = module.slice(0, -".__init__".length);
    return [`${pkg}.x_*`, `${pkg}.xǁ*`];
  }
  // "<module>.*", never "<module>*", which would also select a sibling module whose name
  // starts with this one's.
  return [`${module}.*`];
}

// src/mutmut/stats.py, status_by_exit_code: a code it does not list is "suspicious".
const MUTMUT_STATUS = {
  1: "killed", 3: "killed", 0: "survived", 5: "no tests", 2: "interrupted", 33: "no tests", 34: "skipped",
  35: "suspicious", 36: "timeout", 37: "type check", "-24": "timeout", 24: "timeout", 152: "timeout",
  255: "timeout", "-11": "segfault", "-9": "segfault",
};
const mutmutStatus = (code) => (code === null || code === undefined ? "not checked" : (MUTMUT_STATUS[code] ?? "suspicious"));

// Scores the changed files from mutmut's own per-file records, mutants/<path>.meta,
// whose exit_code_by_key holds every mutant mutmut generated for the file (null until
// it ran; src/mutmut/mutation/data.py). Unlike the CI/CD export, this sees each file.
function countMutmutMeta(report, changed) {
  let detected = 0;
  let undetected = 0;
  const problems = [];
  for (const path of changed) {
    const metaPath = join(report, `${path}.meta`);
    if (!existsSync(metaPath)) {
      problems.push(`${path}: mutmut did not process it (no ${metaPath}); is it under paths_to_mutate, or excluded?`);
      continue;
    }
    let codes;
    try {
      codes = JSON.parse(readFileSync(metaPath, "utf8")).exit_code_by_key;
    } catch (e) {
      problems.push(`${path}: ${metaPath} is not a mutmut record (${e.message})`);
      continue;
    }
    if (!codes || typeof codes !== "object" || Array.isArray(codes)) {
      problems.push(`${path}: ${metaPath} has no exit_code_by_key`);
      continue;
    }
    const statuses = Object.values(codes).map(mutmutStatus);
    const n = (...s) => statuses.filter((x) => s.includes(x)).length;
    const notRun = n("not checked");
    if (notRun) problems.push(`${path}: ${notRun} of ${statuses.length} mutants were generated but not run, so the module pattern does not select them`);
    detected += n("killed", "timeout");
    undetected += n("survived", "no tests", "suspicious", "segfault");
  }
  return { detected, undetected, problems };
}

// ---- PIT 1.30.2 -------------------------------------------------------------------
//
// PIT selects classes by name. Kotlin's conventions let a project omit the common root
// package from the folders (https://kotlinlang.org/docs/coding-conventions.html), and a
// file may declare classes not named after it, so the names come from the source:
// its package line, its top-level class, interface, object, enum and record
// declarations, and for Kotlin the file facade (<File>Kt, or @file:JvmName). Each name
// gives the exact class and its nested classes ("a.b.Foo" and "a.b.Foo$*"; PIT's Glob
// escapes "$"), never a bare prefix that would also select a.b.FooBar.

const DECLARATION =
  /^(?:@[\w.]+(?:\([^)\n]*\))?\s+)*(?:(?:public|internal|private|protected|abstract|open|final|sealed|data|enum|annotation|inner|value|inline|fun|expect|actual|static|strictfp|non-sealed)\s+)*(?:class|interface|object|record|enum|@interface)\s+([A-Za-z_]\w*)/gm;

function pitNames(path) {
  if (!existsSync(path)) fail(2, `${path}: the changed source file is not in the checkout`);
  const text = readFileSync(path, "utf8");
  const pkg = text.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;?/m)?.[1] ?? "";
  const names = new Set([...text.matchAll(DECLARATION)].map((m) => m[1]));
  if (/\.kt$/.test(path)) {
    const base = path.split("/").pop().replace(/\.kt$/, "");
    names.add(text.match(/@file:JvmName\(\s*"([^"]+)"\s*\)/)?.[1] ?? `${base}Kt`);
  }
  return { pkg, names: [...names].sort() };
}

function pitTargets(path) {
  const { pkg, names } = pitNames(path);
  return names.flatMap((n) => {
    const fq = pkg ? `${pkg}.${n}` : n;
    return [fq, `${fq}$*`];
  });
}

function moduleOf(path) {
  const i = path.indexOf("/src/main/");
  return i > 0 ? path.slice(0, i) : null;
}

// A changed file's classes exist when, for at least one of its names, the module's
// compiled output holds <Name>.class or a nested <Name>$<...>.class.
function classesExist(module, path) {
  const { pkg, names } = pitNames(path);
  const dirs = ["kotlin", "java"].map((lang) => join(module, "build", "classes", lang, "main", ...pkg.split(".").filter(Boolean)));
  return names.some((n) =>
    dirs.some((d) => existsSync(join(d, `${n}.class`)) || (existsSync(d) && readdirSync(d).some((f) => f.startsWith(`${n}$`) && f.endsWith(".class")))),
  );
}

// With --changed, each touched module must show that PIT ran (pitest.log) and either
// wrote mutations.xml or said it found no mutation: PIT 1.30.2 with
// failWhenNoMutations=false returns before its analysis and writes no report at all
// (MutationCoverage.java, lines 133-139). Every changed file's classes must exist, so a
// wrong target name never reads as "nothing to mutate".
function countPitChanged(report, changed) {
  let detected = 0;
  let undetected = 0;
  const problems = [];
  const byModule = new Map();
  for (const path of changed) {
    const module = moduleOf(path);
    if (!module) {
      problems.push(`${path}: not under <module>/src/main/`);
      continue;
    }
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(path);
  }
  for (const [module, paths] of byModule) {
    const log = join(report, module, "pitest.log");
    const xml = join(report, module, "mutations.xml");
    if (!existsSync(log)) {
      problems.push(`${module}: PIT did not run for this module (no ${log})`);
      continue;
    }
    if (existsSync(xml)) {
      const c = COUNTERS.pit(readFileSync(xml, "utf8"));
      detected += c.detected;
      undetected += c.undetected;
    } else if (!/no mutations found/i.test(readFileSync(log, "utf8"))) {
      problems.push(`${module}: PIT wrote no mutations.xml and its log does not say "no mutations found", so it did not finish`);
    }
    for (const path of paths) {
      if (!classesExist(module, path)) {
        problems.push(`${path}: no compiled class matches its targets (${pitTargets(path).join(", ")}) under ${module}/build/classes; the names are wrong, or the file declares no class`);
      }
    }
  }
  return { detected, undetected, problems };
}

function patterns(values) {
  if (!values.changed) fail(2, "patterns needs --changed <list of changed source files>");
  const changed = readList(values.changed);
  if (values.format === "mutmut") console.log(changed.flatMap(mutmutPatterns).join("\n"));
  else if (values.format === "pit") console.log([...new Set(changed.flatMap(pitTargets))].sort().join(","));
  else fail(2, `patterns: unknown --format ${values.format}; use mutmut or pit`);
  process.exit(0);
}

function readRatchet(text, where) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    fail(1, `${where}: not valid JSON (${e.message})`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(1, `${where}: must be a JSON object of whole percents`);
  for (const [k, v] of Object.entries(data)) {
    if (!Number.isInteger(v) || v < 0 || v > 100) fail(1, `${where}: "${k}" must be a whole percent from 0 to 100, not ${JSON.stringify(v)}`);
  }
  return data;
}

function score(values) {
  const proven = values.format === "mutmut-meta" || (values.format === "pit" && values.changed);
  const counter = COUNTERS[values.format];
  if (!counter && values.format !== "mutmut-meta") fail(2, `unknown --format ${values.format}`);
  if (values.format === "mutmut-meta" && !values.changed) fail(2, "--format mutmut-meta needs --changed: the gate scores the changed files, one by one");
  if (values.changed && !proven) fail(2, `--changed is read only with --format mutmut-meta or pit, not ${values.format}`);
  if (!values.report) fail(2, "--report is required");
  if ((values.min === undefined) === (values.ratchet === undefined)) fail(2, "give exactly one of --min and --ratchet");

  let threshold;
  if (values.min !== undefined) {
    threshold = Number(values.min);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) fail(2, `--min must be a percent, not ${values.min}`);
  } else {
    if (!existsSync(values.ratchet)) fail(2, `the ratchet file ${values.ratchet} does not exist`);
    const ratchet = readRatchet(readFileSync(values.ratchet, "utf8"), values.ratchet);
    if (!(values.key in ratchet)) fail(2, `${values.ratchet} has no "${values.key}" key`);
    threshold = ratchet[values.key];
  }

  let detected;
  let undetected;
  let problems = [];
  if (proven) {
    const changed = readList(values.changed);
    if (!changed.length) fail(2, `${values.changed} lists no changed file`);
    ({ detected, undetected, problems } =
      values.format === "mutmut-meta" ? countMutmutMeta(values.report, changed) : countPitChanged(values.report, changed));
  } else {
    const path = resolve(values.report);
    if (!existsSync(path)) fail(2, `no mutation report at ${values.report}: the tool did not run or wrote elsewhere`);
    const files = statSync(path).isDirectory() ? walk(path).filter((f) => (values.format === "pit" ? /mutations\.xml$/i.test(f) : /\.json$/i.test(f))) : [path];
    if (!files.length) fail(2, `no mutation report under ${values.report}`);
    ({ detected, undetected } = files
      .map((f) => counter(readFileSync(f, "utf8")))
      .reduce((a, b) => ({ detected: a.detected + b.detected, undetected: a.undetected + b.undetected })));
  }
  const judged = detected + undetected;

  const lines = [];
  const say = (l) => {
    lines.push(l);
    console.log(l);
  };
  let code = 0;
  let pct = null;
  for (const p of problems) say(`FAIL: ${p}`);
  if (problems.length) code = 2;
  if (judged === 0) {
    if (proven && !problems.length) say("No mutant was judged: every changed file was processed by the tool and holds no mutable code.");
    else {
      say("FAIL: the report judges no mutant. A run that measured nothing is not 100%.");
      code = 2;
    }
  } else {
    pct = (detected / judged) * 100;
    const shown = (Math.floor(pct * 10) / 10).toFixed(1);
    const label = values.ratchet ? `ratchet ${threshold}%` : `minimum ${threshold}%`;
    say(`detected ${detected} of ${judged} mutants: ${shown}% (${label})`);
    if (pct + 1e-9 < threshold) {
      say(`FAIL: the mutation score is below ${threshold}%. Kill the survivors with tests that can fail, or exclude a mutant in the code with its reason.`);
      if (code === 0) code = 1;
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    const out = pct === null ? "" : `score=${(Math.floor(pct * 10) / 10).toFixed(1)}\nfloor=${Math.floor(pct + 1e-9)}\n`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${out}threshold=${threshold}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mutation score\n\n${lines.join("\n\n")}\n`);
  process.exit(code);
}

function show(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function guard(values) {
  if (!values.base || !values.head) fail(2, "guard needs --base and --head");
  const before = show(values.base, values.file);
  const after = show(values.head, values.file);
  const problems = [];
  if (after === null) {
    if (before !== null) problems.push(`${values.file} is deleted; the ratchet may only rise`);
  } else {
    const head = readRatchet(after, `${values.file} on the head`);
    if (before !== null) {
      const base = readRatchet(before, `${values.file} on the base`);
      for (const [k, v] of Object.entries(base)) {
        if (!(k in head)) problems.push(`"${k}" (${v}%) is removed; the ratchet may only rise`);
        else if (head[k] < v) problems.push(`"${k}" is lowered from ${v}% to ${head[k]}%; the ratchet may only rise`);
      }
    }
  }
  const summary = problems.length ? `FAIL: ${problems.join("; ")}.` : `${values.file}: no value lowered.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mutation ratchet\n\n${summary}\n`);
  process.exit(problems.length ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    format: { type: "string" },
    report: { type: "string" },
    min: { type: "string" },
    ratchet: { type: "string" },
    key: { type: "string", default: "percent" },
    changed: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    file: { type: "string", default: ".github/mutation-ratchet.json" },
  },
});
if (command === "score") score(values);
else if (command === "patterns") patterns(values);
else if (command === "guard") guard(values);
else fail(2, "usage: mutation-gate.mjs score|patterns|guard ...");
