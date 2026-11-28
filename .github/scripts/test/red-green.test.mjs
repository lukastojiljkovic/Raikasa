// SPDX-License-Identifier: MIT
// The red-green proof is itself a gate, so it is held to the same rule: every case
// below names the break it catches, and each was watched failing before the script
// existed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRepo, run } from "./helpers.mjs";
import * as rg from "../red-green.mjs";

// A namespace import: a function missing from the script fails its own tests, not the file.
const parseReport = (...a) => rg.parseReport(...a);
const readCases = (...a) => rg.readCases(...a);
const selectCases = (...a) => rg.selectCases(...a);
const summarize = (...a) => rg.summarize(...a);

const BUGGY = "export const sum = (a, b) => a - b;\n";
const FIXED = "export const sum = (a, b) => a + b;\n";
const REAL_TEST = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { sum } from "../src/sum.mjs";',
  'test("adds two numbers", () => assert.equal(sum(2, 3), 5));',
  "",
].join("\n");
// Passes against the bug: 0 - 0 and 0 + 0 are both 0, so it cannot detect the fix.
const BLIND_TEST = REAL_TEST.replace("sum(2, 3), 5", "sum(0, 0), 0");

const NODE_TEST = "node --test --test-reporter=junit --test-reporter-destination=junit.xml {files}";

function project({ headSource, headTest, extraHead } = {}) {
  const repo = makeRepo();
  repo.write("src/sum.mjs", BUGGY);
  repo.write("package.json", '{ "type": "module" }\n');
  const base = repo.commit("feat: sum");
  repo.branch("work");
  if (headSource) repo.write("src/sum.mjs", headSource);
  if (headTest) repo.write("test/sum.test.mjs", headTest);
  if (extraHead) extraHead(repo);
  const head = repo.commit("fix: sum adds");
  return { repo, base, head };
}

function proof(p, kind, cmd = NODE_TEST, extra = [], cases = "path") {
  return run(
    "red-green.mjs",
    [
      "--base", p.base, "--head", p.head, "--kind", kind,
      "--tests", "test/", "--cmd", cmd, "--report", "junit.xml", "--format", "junit",
      ...(cases ? ["--cases", cases] : []),
      ...extra,
    ],
    p.repo.dir,
  );
}

// A test that imports a name the base does not export yet: on the base it never
// reaches an assertion. Node reports the file as one failed case named after the file.
const NEEDS_NEW_EXPORT = REAL_TEST.replace("import { sum }", "import { sum, twice }").replace(
  'test("adds two numbers", () => assert.equal(sum(2, 3), 5));',
  'test("adds two numbers", () => assert.equal(sum(2, 3), 5));\ntest("doubles", () => assert.equal(twice(2), 4));',
);
const WITH_EXPORT = `${FIXED}export const twice = (a) => a * 2;\n`;

test("a fix with a real regression test is red on base and green on head", (t) => {
  const p = project({ headSource: FIXED, headTest: REAL_TEST });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RED on base: 1 of 1/);
  assert.match(r.out, /GREEN on head: 1 passed/);
});

test("a test that already passes on base is refused", (t) => {
  const p = project({ headSource: FIXED, headTest: BLIND_TEST });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pass against the base/);
});

test("a fix without any test change is refused", (t) => {
  const p = project({ headSource: FIXED });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /regression test/);
});

test("a fix whose test still fails on head is refused", (t) => {
  const p = project({ headSource: BUGGY.replace("a - b", "a * b"), headTest: REAL_TEST });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /head/i);
});

test("a test that is skipped on head is not green", (t) => {
  // Runs (and fails) against the bug, and skips itself once the bug is gone: the
  // shape of a test that was switched off to make a pull request pass.
  const skipping = REAL_TEST.replace(
    'test("adds two numbers", () =>',
    'test("adds two numbers", { skip: sum(1, 1) === 2 }, () =>',
  );
  const p = project({ headSource: FIXED, headTest: skipping });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RED on base/);
});

test("GREEN refuses to run on a checkout that is not the head", (t) => {
  const p = project({ headSource: FIXED, headTest: REAL_TEST });
  t.after(() => p.repo.cleanup());
  // Left on main, GREEN would run the buggy source and could never be trusted.
  p.repo.checkout("main");
  const r = proof(p, "fix");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not the head/);
});

test("a change that is not a fix or a feature is skipped", (t) => {
  const p = project({ extraHead: (r) => r.write("docs/a.md", "text\n") });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "other");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skipped/i);
});

test("a fix that is red only because the base does not build is refused", (t) => {
  // build.mjs stands in for a compiler: it fails wherever src/feature.mjs is missing.
  const build = 'import { existsSync } from "node:fs"; process.exit(existsSync("src/feature.mjs") ? 0 : 1);\n';
  const p = project({
    headSource: FIXED,
    headTest: REAL_TEST,
    extraHead: (r) => {
      r.write("build.mjs", build);
      r.write("src/feature.mjs", "export const x = 1;\n");
    },
  });
  t.after(() => p.repo.cleanup());
  // build.mjs is not a test file, so the base worktree has none: the base run fails
  // before a single test runs. That is not a failing assertion.
  const cmd = `node build.mjs && ${NODE_TEST}`;
  const r = proof(p, "fix", cmd);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /did not run|build/i);
});

test("a feature may be red because the base does not build", (t) => {
  const build = 'import { existsSync } from "node:fs"; process.exit(existsSync("src/feature.mjs") ? 0 : 1);\n';
  const p = project({
    headSource: FIXED,
    headTest: REAL_TEST,
    extraHead: (r) => {
      r.write("build.mjs", build);
      r.write("src/feature.mjs", "export const x = 1;\n");
    },
  });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "feat", `node build.mjs && ${NODE_TEST}`);
  assert.equal(r.code, 0, r.out);
});

test("a fix whose test fails on base only because an import is missing is refused", (t) => {
  // The shape of brief item 00000000.'s "always-true" trap in reverse: red for the
  // wrong reason. Before this rule, Node's failed-to-load case counted as RED.
  const p = project({ headSource: WITH_EXPORT, headTest: NEEDS_NEW_EXPORT });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /errored on base/);
});

test("a feature may be red because its new export does not exist on base", (t) => {
  const p = project({ headSource: WITH_EXPORT, headTest: NEEDS_NEW_EXPORT });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "feat");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARNING/);
  assert.match(r.out, /GREEN on head: 2 passed/);
});

test("RED counts only the changed tests, not an unrelated test that fails on base", (t) => {
  // other.test.mjs is broken on the base and repaired on the head by a source
  // change. It must not lend its failure to a blind test in the changed file.
  const other = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { existsSync } from "node:fs";',
    'test("other", () => assert.ok(existsSync("src/repaired.mjs")));',
    "",
  ].join("\n");
  const repo = makeRepo();
  repo.write("src/sum.mjs", BUGGY);
  repo.write("package.json", '{ "type": "module" }\n');
  repo.write("test/other.test.mjs", other);
  const base = repo.commit("feat: sum");
  repo.branch("work");
  repo.write("src/sum.mjs", FIXED);
  repo.write("src/repaired.mjs", "export {};\n");
  repo.write("test/sum.test.mjs", BLIND_TEST);
  const head = repo.commit("fix: sum adds");
  t.after(() => repo.cleanup());
  // The whole suite runs, as it does for .NET, Rust and Gradle. The files are a glob, not a folder: Node 24's test runner
  // takes a folder argument for a file and fails with MODULE_NOT_FOUND (Node 26 recurses into it), so a command that names
  // the folder runs no test on the Node the jobs use (B0-U01).
  const whole = 'node --test --test-reporter=junit --test-reporter-destination=junit.xml "test/*.test.mjs"';
  const r = proof({ repo, base, head }, "fix", whole);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pass against the base/);
});

test("--cases is required, so a whole-suite command cannot be counted by accident", (t) => {
  const p = project({ headSource: FIXED, headTest: REAL_TEST });
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix", NODE_TEST, [], null);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--cases/);
});

test("a fix whose base run errors in collection or setup is refused (pytest-shaped report)", (t) => {
  // Stands in for pytest: on the base the module cannot be imported, which pytest
  // writes as <error message="collection failure"> on a case named after the module.
  const runner = [
    'import { existsSync, writeFileSync } from "node:fs";',
    "const head = existsSync('src/feature.mjs');",
    "const body = head",
    "  ? '<testcase classname=\"test.test_sum\" name=\"test_adds\"/>'",
    "  : '<testcase classname=\"\" name=\"test.test_sum\"><error message=\"collection failure\">ImportError</error></testcase>';",
    "writeFileSync('junit.xml', `<testsuites><testsuite name=\"pytest\">${body}</testsuite></testsuites>`);",
    "process.exit(head ? 0 : 1);",
    "",
  ].join("\n");
  const p = project({
    headSource: FIXED,
    extraHead: (r) => {
      r.write("test/test_sum.py", "def test_adds(): pass\n");
      r.write("src/feature.mjs", "export {};\n");
    },
  });
  p.repo.write("runner.mjs", runner);
  t.after(() => p.repo.cleanup());
  // runner.mjs is untracked, so the base worktree does not have it: lay it in
  // through an absolute path, as a real runner is installed outside the tree.
  const r = proof(p, "fix", `node "${p.repo.dir}/runner.mjs"`, [], "python");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /errored on base/);
});

test("GREEN refuses a changed test that errors on head even when the runner exits 0", (t) => {
  // Some runners exit 0 when a test errors in teardown; the report is the authority.
  const runner = [
    'import { existsSync, writeFileSync } from "node:fs";',
    "const head = existsSync('src/feature.mjs');",
    "const body = head",
    "  ? '<testcase classname=\"test.test_sum\" name=\"test_adds\"><error message=\"failed on teardown\"/></testcase>'",
    "  : '<testcase classname=\"test.test_sum\" name=\"test_adds\"><failure message=\"assert 1 == 2\"/></testcase>';",
    "writeFileSync('junit.xml', `<testsuites><testsuite name=\"pytest\">${body}</testsuite></testsuites>`);",
    "process.exit(head ? 0 : 1);",
    "",
  ].join("\n");
  const p = project({
    headSource: FIXED,
    extraHead: (r) => {
      r.write("test/test_sum.py", "def test_adds(): pass\n");
      r.write("src/feature.mjs", "export {};\n");
    },
  });
  p.repo.write("runner.mjs", runner);
  t.after(() => p.repo.cleanup());
  const r = proof(p, "fix", `node "${p.repo.dir}/runner.mjs"`, [], "python");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RED on base/);
  assert.match(r.out, /1 errored of 1/);
});

test("JUnit reports separate failures, errors and skips", () => {
  const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="s" tests="3">
<testcase name="a"/>
<testcase name="b"><failure message="x"/></testcase>
<testcase name="c"><error message="y"/></testcase>
<testcase name="d"><skipped/></testcase>
</testsuite></testsuites>`;
  assert.deepEqual(parseReport(xml, "junit"), { total: 4, failed: 1, errored: 1, skipped: 1 });
});

test("a case named after its own file is a load failure, not an assertion (Node and Vitest)", () => {
  const xml = `<testsuites>
<testcase name="test\\missing.test.mjs" classname="test" file="C:\\w\\test\\missing.test.mjs"><failure message="test failed"/></testcase>
<testcase name="src/a.test.ts" classname="src/a.test.ts"><failure message="Failed to load url"/></testcase>
<testcase name="adds" classname="src/a.test.ts"><failure message="expected 5"/></testcase>
</testsuites>`;
  assert.deepEqual(readCases(xml, "junit").map((c) => c.status), ["errored", "errored", "failed"]);
});

test("Gradle's synthetic container cases are errors, not assertions", () => {
  const xml = `<testsuite>
<testcase name="initializationError" classname="com.example.FooTest"><failure message="x"/></testcase>
<testcase name="executionError" classname="com.example.FooTest"><failure message="x"/></testcase>
<testcase name="classMethod" classname="com.example.FooTest"><failure message="x"/></testcase>
<testcase name="parses()" classname="com.example.FooTest"><failure message="x"/></testcase>
</testsuite>`;
  assert.deepEqual(readCases(xml, "junit").map((c) => c.status), ["errored", "errored", "errored", "failed"]);
});

test("TRX reports join results to their class and map outcomes", () => {
  const trx = `<TestRun><Results>
<UnitTestResult testId="1" testName="a" outcome="Passed" />
<UnitTestResult testId="2" testName="b" outcome="Failed"><Output/></UnitTestResult>
<UnitTestResult testId="3" testName="c" outcome="NotExecuted" />
<UnitTestResult testId="4" testName="d" outcome="Error" />
</Results><TestDefinitions>
<UnitTest name="a" id="1"><TestMethod className="App.Tests.SumTests" name="a"/></UnitTest>
<UnitTest name="b" id="2"><TestMethod className="App.Tests.SumTests" name="b"/></UnitTest>
<UnitTest name="c" id="3"><TestMethod className="App.Tests.OtherTests" name="c"/></UnitTest>
<UnitTest name="d" id="4"><TestMethod className="App.Tests.SumTests+Nested" name="d"/></UnitTest>
<UnitTest name="e" id="5"><TestMethod className="App.Tests.CheckSumTests" name="e"/></UnitTest>
</TestDefinitions></TestRun>`.replace("</Results>", '<UnitTestResult testId="5" testName="e" outcome="Passed" /></Results>');
  assert.deepEqual(parseReport(trx, "trx"), { total: 5, failed: 1, errored: 1, skipped: 1 });
  // CheckSumTests ends with "SumTests" but is another class.
  const mine = selectCases(readCases(trx, "trx"), ["tests/App.Tests/SumTests.cs"], "dotnet");
  assert.deepEqual(mine.map((c) => c.name), ["a", "b", "d"]);
});

test("each --cases mode keeps exactly the cases of the changed files", () => {
  const junit = (cases) => `<testsuites>${cases.map(([cls, name, file]) => `<testcase classname="${cls}" name="${name}"${file ? ` file="${file}"` : ""}/>`).join("")}</testsuites>`;
  const names = (xml, files, mode) => selectCases(readCases(xml, "junit"), files, mode).map((c) => c.name);

  // pytest: dotted module, a class inside it, the collection error named after the
  // module, and a project in a subfolder whose rootdir is not the repository root.
  const py = junit([["tests.test_sum", "t1"], ["tests.test_sum.TestSum", "t2"], ["", "tests.test_sum"], ["tests.test_other", "t3"], ["tests.test_sum_extra", "t4"]]);
  assert.deepEqual(names(py, ["backend/tests/test_sum.py"], "python"), ["t1", "t2", "tests.test_sum"]);

  // Gradle: the class from src/test/kotlin, its nested classes, not a prefix-sharing class.
  const jvm = junit([["com.example.FooTest", "a"], ["com.example.FooTest$Nested", "b"], ["com.example.FooTestHelper", "c"]]);
  assert.deepEqual(names(jvm, ["core/src/test/kotlin/com/example/FooTest.kt"], "jvm"), ["a", "b"]);

  // nextest: a sibling tests.rs module of a library, and an integration test binary.
  const rs = junit([["my-crate", "parser::tests::reads"], ["my-crate", "parser::other"], ["my-crate::api", "serves"], ["my-crate::apis", "x"]]);
  assert.deepEqual(names(rs, ["crates/my-crate/src/parser/tests.rs"], "rust"), ["parser::tests::reads"]);
  assert.deepEqual(names(rs, ["crates/my-crate/tests/api.rs"], "rust"), ["serves"]);
  // A tests/ folder under src/ is a module path, not an integration test binary.
  const nested = junit([["my-crate", "net::tests::wire::frames"], ["my-crate::wire", "x"]]);
  assert.deepEqual(names(nested, ["src/net/tests/wire.rs"], "rust"), ["net::tests::wire::frames"]);

  // Node and Vitest: by file attribute or by a classname that is the file path.
  const js = junit([["test", "n1", "/tmp/x/test/sum.test.mjs"], ["test", "n2", "/tmp/x/test/other.test.mjs"], ["packages/a/src/b.test.ts", "v1"], ["src/b.test.ts", "v2"]]);
  assert.deepEqual(names(js, ["test/sum.test.mjs"], "path"), ["n1"]);
  assert.deepEqual(names(js, ["packages/a/src/b.test.ts"], "path"), ["v1", "v2"]);

  assert.equal(selectCases(readCases(js, "junit"), [], "all").length, 4);
  assert.throws(() => selectCases([], [], "everything"), /unknown --cases/);
});

test("summarize counts each status once", () => {
  assert.deepEqual(
    summarize([{ status: "passed" }, { status: "failed" }, { status: "errored" }, { status: "skipped" }, { status: "failed" }]),
    { total: 5, failed: 2, errored: 1, skipped: 1 },
  );
});
