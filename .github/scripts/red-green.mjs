#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Red-green proof for a pull request. A test that has never been seen failing is
// indistinguishable from one that cannot fail, so for a fix or a feature this
// script demands both halves on CI:
//
//   RED    the pull request's new and changed test files, copied onto the BASE
//          source (the merge base), must fail: at least one test case fails.
//   GREEN  the same tests on the HEAD of the pull request must all pass.
//
// Only test cases that come from the changed test files count (--cases says how a
// report names its file), so an unrelated test that is broken or flaky on the base
// cannot lend its failure to the proof. A case is "errored" when it never reached an
// assertion: a JUnit <error> (pytest collection, setup and teardown errors), a file
// that failed to load (Node and Vitest report it as a case named after the file), a
// Gradle container failure (initializationError, executionError, classMethod), or a
// TRX Error or Aborted outcome.
//
// For a `fix`, RED must be a failing assertion: a base that does not build, or whose
// changed tests only error, proves nothing about the test, so it is refused. For a
// `feat` a base that cannot build or import the new API is accepted as RED, with a
// warning. Any other kind (docs, ci, chore, ...) is skipped.
//
// Usage:
//   node red-green.mjs --base <ref> --head <ref> --kind fix|feat|other
//        --tests <pathspec> [--tests <pathspec>]...
//        --cmd "<test command; {files} becomes the changed test files>"
//        --report <file or directory, relative to the checkout> --format junit|trx
//        --cases path|python|jvm|dotnet|rust|all
//
// --cases: path   Node, Vitest, Jest (JUnit `file`, or a classname that is the path)
//          python pytest (classname is the dotted module, optionally .Class)
//          jvm    Gradle JUnit XML (classname is the class from src/<set>/<lang>/)
//          dotnet TRX (the test class is named after its file)
//          rust   cargo-nextest (unit tests in a tests.rs module, or tests/<bin>.rs)
//          all    every case in the report (only when {files} limits the run)
//
// The command runs through the shell, in the base worktree for RED and in the
// current checkout (which must be HEAD) for GREEN. The changed test files are also
// passed in the RG_FILES environment variable, one per line.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

function attributes(tag) {
  const out = {};
  for (const [, k, v] of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[k] = unescape(v);
  return out;
}

const norm = (p) => (p ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
// Two paths name the same file when one is the other, or ends with it at a
// directory boundary (an absolute `file` attribute against a repository path, or a
// path relative to a sub-project's root against one relative to the repository).
function samePath(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

const SYNTHETIC_JVM = new Set(["initializationError", "executionError", "classMethod"]);

// Every test case in a report, with its naming attributes and one status:
// passed, failed (an assertion), errored (never reached an assertion) or skipped.
export function readCases(text, format) {
  if (format === "junit") {
    const cases = [];
    for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = attributes(m[1]);
      const body = m[2] ?? "";
      let status = /<failure\b/.test(body) ? "failed" : /<error\b/.test(body) ? "errored" : /<skipped\b/.test(body) ? "skipped" : "passed";
      const name = a.name ?? "";
      const loadFailure = /\.[A-Za-z0-9]+$/.test(name) && (samePath(name, a.file) || samePath(name, a.classname));
      if (status === "failed" && (loadFailure || SYNTHETIC_JVM.has(name))) status = "errored";
      cases.push({ name, classname: a.classname ?? "", file: a.file ?? "", status });
    }
    return cases;
  }
  if (format === "trx") {
    const classOf = new Map();
    for (const m of text.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
      const method = m[2].match(/<TestMethod\b([^>]*)>/);
      classOf.set(attributes(m[1]).id, method ? (attributes(method[1]).className ?? "") : "");
    }
    const STATUS = { Passed: "passed", Failed: "failed", Timeout: "failed", Error: "errored", Aborted: "errored", NotExecuted: "skipped", Inconclusive: "skipped" };
    return [...text.matchAll(/<UnitTestResult\b([^>]*)>/g)].map((m) => {
      const a = attributes(m[1]);
      return { name: a.testName ?? "", classname: classOf.get(a.testId) ?? "", file: "", status: STATUS[a.outcome] ?? "errored" };
    });
  }
  throw new Error(`unknown report format ${format}`);
}

export function summarize(cases) {
  const count = (s) => cases.filter((c) => c.status === s).length;
  return { total: cases.length, failed: count("failed"), errored: count("errored"), skipped: count("skipped") };
}

export function parseReport(text, format) {
  return summarize(readCases(text, format));
}

// Does a dotted name (a.b.c, possibly a.b.c.Class) name the module `key`, whose
// leading folders may be missing because the runner's root is a sub-project?
function namesModule(dotted, key) {
  const segs = dotted.split(".").filter(Boolean);
  for (let i = segs.length; i >= 1; i--) {
    const p = segs.slice(0, i).join(".");
    if (p === key || key.endsWith(`.${p}`)) return true;
  }
  return false;
}

const MATCHERS = {
  all: () => () => true,
  path: (f) => (c) => samePath(c.file, f) || samePath(c.classname, f),
  python: (f) => {
    const key = norm(f).replace(/\.py$/, "").replaceAll("/", ".");
    return (c) => namesModule(c.classname, key) || (!c.classname && namesModule(c.name, key));
  },
  jvm: (f) => {
    const m = norm(f).match(/(?:^|\/)src\/[^/]+\/(?:kotlin|java|groovy|scala)\/(.+)\.(?:kt|java|groovy|scala)$/);
    if (!m) return () => false;
    const cls = m[1].replaceAll("/", ".");
    return (c) => c.classname === cls || c.classname.startsWith(`${cls}$`) || c.classname.startsWith(`${cls}.`);
  },
  dotnet: (f) => {
    const cls = norm(f).split("/").pop().replace(/\.cs$/, "");
    return (c) => c.classname === cls || c.classname.endsWith(`.${cls}`) || c.classname.startsWith(`${cls}+`) || c.classname.includes(`.${cls}+`);
  },
  rust: (f) => {
    const p = norm(f);
    // A module under src/ first: src/a/tests/b.rs is a module, not a test binary.
    const src = p.match(/(?:^|\/)src\/(.+)\.rs$/);
    if (src) {
      const module = src[1].replace(/\/mod$/, "").replaceAll("/", "::");
      return (c) => c.name.startsWith(`${module}::`);
    }
    const bin = p.match(/(?:^|\/)tests\/([^/]+?)(?:\.rs$|\/)/);
    if (bin) return (c) => c.classname.endsWith(`::${bin[1]}`);
    return () => false;
  },
};

// The cases that come from the changed test files.
export function selectCases(cases, files, mode) {
  if (!MATCHERS[mode]) throw new Error(`unknown --cases mode ${mode}`);
  if (mode === "all") return cases;
  const tests = files.map(MATCHERS[mode]);
  return cases.filter((c) => tests.some((t) => t(c)));
}

function readReports(root, report, format) {
  const path = resolve(root, report);
  if (!existsSync(path)) return null;
  const files = statSync(path).isDirectory() ? walk(path).filter((f) => /\.(xml|trx)$/i.test(f)) : [path];
  if (!files.length) return null;
  return files.flatMap((f) => readCases(readFileSync(f, "utf8"), format));
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function git(args, cwd = process.cwd(), encoding = "utf8") {
  return execFileSync("git", args, { cwd, encoding, maxBuffer: 256 * 1024 * 1024 });
}

function runTests(cmd, cwd, files) {
  const quoted = files.map((f) => `"${f}"`).join(" ");
  // nosemgrep: node-child-process-shell-option -- cmd is the workflow's own --cmd text: a pull request that edits it already controls the job's commands, and no pull-request text (title, branch name, label) reaches it; {files} adds only the pull request's own test paths, and this job runs those tests' code anyway
  const r = spawnSync(cmd.replaceAll("{files}", quoted), {
    cwd,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, RG_FILES: files.join("\n") },
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status ?? 1, log: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      kind: { type: "string" },
      tests: { type: "string", multiple: true, default: [] },
      cmd: { type: "string" },
      report: { type: "string" },
      format: { type: "string", default: "junit" },
      cases: { type: "string" },
    },
  });
  const lines = [];
  const say = (l) => {
    lines.push(l);
    console.log(l);
  };
  const finish = (code) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Red-green proof\n\n${lines.join("\n\n")}\n`);
    process.exit(code);
  };

  if (!values.kind || !["fix", "feat", "other"].includes(values.kind)) {
    console.error("--kind must be fix, feat or other");
    process.exit(2);
  }
  if (values.kind === "other") {
    say("Skipped: the change is neither a fix nor a feature.");
    finish(0);
  }
  if (!values.base || !values.head || !values.cmd || !values.report || !values.tests.length || !values.cases) {
    console.error("usage: red-green.mjs --base --head --kind --tests ... --cmd --report --format --cases path|python|jvm|dotnet|rust|all");
    process.exit(2);
  }
  if (!MATCHERS[values.cases]) {
    console.error(`unknown --cases mode ${values.cases}`);
    process.exit(2);
  }

  const base = git(["merge-base", values.base, values.head]).trim();
  const changed = git(["diff", "--name-only", "--diff-filter=AMR", `${base}...${values.head}`, "--", ...values.tests])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!changed.length) {
    say(
      values.kind === "fix"
        ? "FAIL: a fix must add or change a regression test that reproduces the bug, and none of the test paths changed."
        : "FAIL: a feature must add tests, and none of the test paths changed.",
    );
    finish(1);
  }
  say(`Changed test files: ${changed.join(", ")}`);

  // RED: the base source with the pull request's tests laid over it.
  const tree = mkdtempSync(join(tmpdir(), "red-green-"));
  let red;
  try {
    git(["worktree", "add", "--detach", tree, base]);
    for (const f of changed) {
      const bytes = git(["show", `${values.head}:${f}`], process.cwd(), "buffer");
      mkdirSync(dirname(join(tree, f)), { recursive: true });
      writeFileSync(join(tree, f), bytes);
    }
    const run = runTests(values.cmd, tree, changed);
    const all = readReports(tree, values.report, values.format);
    red = { ...run, all, result: all && summarize(selectCases(all, changed, values.cases)) };
  } finally {
    try {
      git(["worktree", "remove", "--force", tree]);
    } catch {
      rmSync(tree, { recursive: true, force: true });
      git(["worktree", "prune"]);
    }
  }

  const fence = (out) => `\n\n\`\`\`\n${out.slice(-4000)}\n\`\`\``;
  const r = red.result;
  if (!r || r.total === 0) {
    // Nothing from the changed files ran: the base does not build, or --cases does
    // not match how this runner names its cases (then the report holds other cases).
    const why = red.all?.length
      ? `none of the ${red.all.length} test case(s) in the report comes from the changed files; check --cases ${values.cases}`
      : "no test results";
    if (values.kind === "fix") {
      say(
        `FAIL: on base the changed tests did not run (exit ${red.code}, ${why}). A fix's regression test must build against the base and fail on an assertion; a base that does not build proves nothing about the test.${fence(red.log)}`,
      );
      finish(1);
    }
    say(`WARNING: on base the changed tests did not build or run (exit ${red.code}, ${why}); accepted as RED for a feature whose API is new.`);
  } else if (r.failed === 0 && r.errored > 0) {
    // An import, collection, load or setup error is red for the wrong reason.
    if (values.kind === "fix") {
      say(
        `FAIL: the changed tests errored on base (${r.errored} of ${r.total}: an import, collection, load or setup error) instead of failing an assertion. A fix's regression test must reach its assertion on the base and fail there.${fence(red.log)}`,
      );
      finish(1);
    }
    say(`WARNING: the changed tests errored on base (${r.errored} of ${r.total}) instead of failing an assertion; accepted as RED for a feature whose API is new.`);
  } else if (r.failed === 0) {
    const how = r.skipped
      ? `all ${r.total} test case(s) from the changed files pass or are skipped against the base`
      : `all ${r.total} test case(s) from the changed files pass against the base`;
    say(`FAIL: ${how}. They do not detect the change, so they cannot catch its regression.`);
    finish(1);
  } else {
    say(`RED on base: ${r.failed} of ${r.total} test case(s) from the changed files fail an assertion, as they must.`);
  }

  // GREEN: the same tests on the pull request's own head.
  const current = git(["rev-parse", "HEAD"]).trim();
  const wanted = git(["rev-parse", values.head]).trim();
  if (current !== wanted) {
    say(`FAIL: the checkout is ${current}, not the head ${wanted}; GREEN must run on the head.`);
    finish(1);
  }
  const reportPath = resolve(process.cwd(), values.report);
  rmSync(reportPath, { recursive: true, force: true });
  const green = runTests(values.cmd, process.cwd(), changed);
  const greenAll = readReports(process.cwd(), values.report, values.format);
  const gr = greenAll && summarize(selectCases(greenAll, changed, values.cases));
  // All-skipped is not green (a skipped test asserts nothing), and neither is an error.
  if (green.code !== 0 || !gr || gr.failed > 0 || gr.errored > 0 || gr.total - gr.skipped === 0) {
    const counts = gr ? `${gr.failed} failed and ${gr.errored} errored of ${gr.total} from the changed files` : "no test results";
    say(`FAIL: on head the changed tests do not all pass (exit ${green.code}, ${counts}).${fence(green.log)}`);
    finish(1);
  }
  say(`GREEN on head: ${gr.total - gr.failed - gr.errored - gr.skipped} passed, ${gr.skipped} skipped.`);
  finish(0);
}

// Real paths on both sides: Node gives import.meta.url as the module's real path, so a script path or working folder
// through a junction or symlink would not match the path as typed, and the command would exit 0 having checked nothing
// (B0-U02's inspector 8, N1; B0-U01 round 8).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) main();
