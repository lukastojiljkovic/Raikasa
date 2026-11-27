// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeRepo, run } from "./helpers.mjs";

// Built at run time so this file never contains a placeholder of its own.
const PLACEHOLDER = `{{${"tpl:APP_NAME"}}}`;
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const GOOD_WORKFLOW = `name: CI
on: [pull_request]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
      - uses: ./.github/actions/local
      - run: echo ok
`;

const COMPLETE = {
  "README.md": "# App\n",
  LICENSE: "GNU GENERAL PUBLIC LICENSE\n",
  "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
  "SECURITY.md": "Report privately.\n",
  "CODE_OF_CONDUCT.md": "Be kind.\n",
  "CONTRIBUTING.md": "How to contribute.\n",
  "SUPPORT.md": "Where to ask.\n",
  "PRIVACY.md": "What is collected.\n",
  "TERMS.md": "Terms.\n",
  "TRADEMARKS.md": "Our names and third-party marks.\n",
  "THIRD-PARTY-NOTICES.md": "Notices.\n",
  ".editorconfig": "root = true\n",
  ".gitattributes": "* text=auto\n",
  ".gitignore": "/internal/\n",
  ".github/dependabot.yml": "version: 2\n",
  ".github/CODEOWNERS": "* @owner\n",
  ".github/PULL_REQUEST_TEMPLATE.md": "## What\n",
  ".github/ISSUE_TEMPLATE/config.yml": "blank_issues_enabled: false\n",
  ".github/workflows/ci.yml": GOOD_WORKFLOW,
};

function check(files, profile = "app") {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-test-"));
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const r = run("check-hygiene.mjs", ["--root", dir, "--profile", profile], dir);
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test("a complete repository passes", () => {
  const r = check(COMPLETE);
  assert.equal(r.code, 0, r.out);
});

test("a missing security policy fails and is named", () => {
  const r = check({ ...COMPLETE, "SECURITY.md": null });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SECURITY\.md/);
});

test("an empty file counts as missing", () => {
  const r = check({ ...COMPLETE, "PRIVACY.md": "  \n" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PRIVACY\.md/);
});

test("a LICENSES directory satisfies the licence requirement", () => {
  const r = check({ ...COMPLETE, LICENSE: null, "LICENSES/GPL-3.0-or-later.txt": "GPL text\n" });
  assert.equal(r.code, 0, r.out);
});

test("no licence at all fails", () => {
  const r = check({ ...COMPLETE, LICENSE: null });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /licen[cs]e/i);
});

test("a template placeholder left in a file fails and names the file", () => {
  const r = check({ ...COMPLETE, "SUPPORT.md": `Ask about ${PLACEHOLDER}.\n` });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SUPPORT\.md/);
});

// The template ships .github/actions/standard-user/StandardUser.psm1, whose SPDX line is a placeholder; a module
// manifest (.psd1) is a text file of the same kind. The name is built at run time, as above.
test("a template placeholder left in a PowerShell module fails (B0-U05)", () => {
  const spdx = `{{${"tpl:SPDX_LICENSE"}}}`;
  for (const name of ["StandardUser.psm1", "StandardUser.psd1"]) {
    const r = check({ "README.md": "# Me\n", [`.github/actions/standard-user/${name}`]: `# SPDX-${"License-Identifier"}: ${spdx}\n` }, "profile");
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, new RegExp(`${name.replace(".", "\\.")}:1: a template placeholder is left`));
  }
});

test("an action pinned to a tag fails", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": GOOD_WORKFLOW.replace(`@${SHA}`, "@v7") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /actions\/checkout@v7/);
});

test("an action pinned to a short SHA fails", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": GOOD_WORKFLOW.replace(`@${SHA}`, "@3d3c42e") });
  assert.equal(r.code, 1, r.out);
});

test("a workflow without top-level permissions fails", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": GOOD_WORKFLOW.replace("permissions:\n  contents: read\n", "") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /permissions/);
});

test("pull_request_target is refused", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": GOOD_WORKFLOW.replace("on: [pull_request]", "on: [pull_request_target]") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pull_request_target/);
});

test("the internal folder must be ignored", () => {
  const r = check({ ...COMPLETE, ".gitignore": "node_modules/\n" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /internal/);
});

test("the profile repository needs only a README", () => {
  const r = check({ "README.md": "# Me\n", "index.html": "<!doctype html>\n" }, "profile");
  assert.equal(r.code, 0, r.out);
});

test("double-brace syntax that is not a template placeholder is left alone", () => {
  // Anki cloze text in a test, and a release-notes template filled in at run time.
  const r = check({
    ...COMPLETE,
    "src/cloze.test.ts": 'expect(parse("{{A}}")).toBe(1);\n',
    ".github/release-notes.md": "## Changes\n\n{{CHANGES}}\n",
  });
  assert.equal(r.code, 0, r.out);
});

// B0-U01: the scripts and their tests are text files too, so the hygiene check reads them in an adopted
// repository. A placeholder name that README.md's table does not list (an example in a doc comment, say)
// would make every adopter's hygiene check red, and only the first placeholder per file is reported, so
// SPDX_LICENSE on line 2 hid it in the unfilled template. The regex is built at run time so this file
// carries no placeholder of its own.
test("the scripts and tests of this folder carry no placeholder name but SPDX_LICENSE, so an adopter who fills that one name passes the hygiene check (B0-U01)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // test-docs/ holds check-docs.mjs's tests, which only the docs job runs (B0-U01 round 8).
  const docs = join(here, "..", "test-docs");
  const files = [];
  for (const dir of [join(here, ".."), here, docs].filter((d) => existsSync(d))) {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile()) files.push(join(dir, e.name));
  }
  // No count floor: an adopter deletes the scripts it does not use (check-site.mjs, generate-notices.mjs and its test).
  // The hygiene script and this test are always there, so an empty or wrong folder cannot pass by finding nothing.
  assert.ok(files.some((f) => basename(f) === "check-hygiene.mjs") && files.some((f) => basename(f) === "check-hygiene.test.mjs"), `expected the scripts and their tests, found ${files.map((f) => basename(f)).join(", ")}`);
  if (existsSync(docs)) assert.ok(files.some((f) => dirname(f) === docs), "test-docs/ is there but none of its files was read");
  const name = new RegExp(`\\{\\{${"tpl:"}([A-Z][A-Z0-9_]*)\\}\\}`, "g");
  const names = new Map();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(name)) names.set(m[1], [...(names.get(m[1]) ?? []), basename(f)]);
  }
  // SPDX_LICENSE is the only name allowed, not a name that must be present: an adopter has filled it, and then
  // the folder holds no placeholder at all.
  const others = [...names].filter(([k]) => k !== "SPDX_LICENSE");
  assert.deepEqual(others, [], `unlisted placeholder names in: ${JSON.stringify(others)}`);
});

test("a repository holding this folder's scripts, with SPDX_LICENSE filled, passes the hygiene check (B0-U01)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = { ...COMPLETE };
  const docs = join(here, "..", "test-docs");
  for (const [dir, prefix] of [[join(here, ".."), ".github/scripts/"], [here, ".github/scripts/test/"], [docs, ".github/scripts/test-docs/"]].filter(([d]) => existsSync(d))) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.(mjs|sh)$/.test(e.name)) files[prefix + e.name] = readFileSync(join(dir, e.name), "utf8").replaceAll(`{{${"tpl:"}SPDX_LICENSE}}`, "GPL-3.0-or-later");
    }
  }
  if (existsSync(docs)) assert.ok(Object.keys(files).some((f) => f.startsWith(".github/scripts/test-docs/")), "test-docs/ is there but none of its files was read");
  const r = check(files);
  assert.equal(r.code, 0, r.out);
});

// B0-U02's inspector 8, N1: a script reached through a junction (Windows) or a symbolic link (elsewhere) exited 0 and
// checked nothing, because its main-module guard compared the path as typed with import.meta.url, which Node gives as
// the real path. Each script of this folder with that guard runs here by its real path and through a linked folder,
// and must answer the same way both times (B0-U01 round 8). check-docs.mjs's own tests cover its guard.
test("each script with a main-module guard runs when its folder is reached through a junction or a symbolic link (B0-U01)", () => {
  const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tmp = mkdtempSync(join(tmpdir(), "hygiene-link-"));
  const link = join(tmp, "link");
  const root = join(tmp, "root");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "# Me\n");
  try {
    // "junction" is read on Windows only (it needs no privilege there); elsewhere this makes a symbolic link.
    symlinkSync(scripts, link, "junction");
    const cases = [
      ["check-hygiene.mjs", ["--root", root, "--profile", "profile"], 0, /Repository hygiene: no problems/],
      ["licence-configs.mjs", [], 2, /give exactly one of --write and --check/],
      ["red-green.mjs", ["--kind", "other"], 0, /neither a fix nor a feature/],
      ["check-installer.mjs", [], 2, /no script given/],
    ].filter(([name]) => existsSync(join(scripts, name)));
    assert.ok(cases.some(([name]) => name === "check-hygiene.mjs"), "check-hygiene.mjs is not beside this folder");
    const env = { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "" };
    delete env.NODE_TEST_CONTEXT;
    // With --preserve-symlinks-main, Node gives import.meta.url as the path through the link, so that side is made real too.
    const ways = (name) => [
      ["its real path", [join(scripts, name)], root],
      ["the link", [join(link, name)], root],
      ["a working folder in the link", [name], link],
      ["the link with --preserve-symlinks-main", ["--preserve-symlinks-main", join(link, name)], root],
    ];
    for (const [name, args, code, says] of cases) {
      for (const [how, file, cwd] of ways(name)) {
        const r = spawnSync(process.execPath, [...file, ...args], { cwd, encoding: "utf8", env });
        assert.equal(r.status, code, `${name} through ${how}: exit ${r.status}: ${r.stdout}${r.stderr}`);
        assert.match(`${r.stdout}${r.stderr}`, says, `${name} through ${how}`);
      }
    }
  } finally {
    // The link alone is removed first: its target is this folder.
    try {
      unlinkSync(link);
    } catch {
      // no link was made
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("NOTICE stands in for THIRD-PARTY-NOTICES.md", () => {
  const r = check({ ...COMPLETE, "THIRD-PARTY-NOTICES.md": null, NOTICE: "Apache-style notice\n" });
  assert.equal(r.code, 0, r.out);
});

test("without any notices file the check fails", () => {
  const r = check({ ...COMPLETE, "THIRD-PARTY-NOTICES.md": null });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOTICE/);
});

test("a file under internal/ that is tracked fails, even though .gitignore lists the folder", (t) => {
  // `git add -f` defeats .gitignore; R10 says internal documents never reach the repository.
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  for (const [path, text] of Object.entries(COMPLETE)) repo.write(path, text);
  repo.commit("chore: hygiene files");
  const clean = run("check-hygiene.mjs", ["--root", repo.dir], repo.dir);
  assert.equal(clean.code, 0, clean.out);
  repo.write("internal/specs/feature.md", "Internal.\n");
  git(repo.dir, ["add", "-f", "internal/specs/feature.md"]);
  repo.commit("docs: oops");
  const r = run("check-hygiene.mjs", ["--root", repo.dir], repo.dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /internal\/specs\/feature\.md is tracked/);
});

test("a missing TRADEMARKS.md fails and is named (PG-D16, PG-D21)", () => {
  const r = check({ ...COMPLETE, "TRADEMARKS.md": null });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /TRADEMARKS\.md is missing or empty/);
});

// harden-runner wiring (CV-D58): block mode, telemetry off, never on Windows or macOS.
const HARDEN = "46b06cea07f9e64621fdf066ba77ac6915163d43";
const hardened = ({ runsOn = "ubuntu-24.04", egress = "block", telemetry = "      disable-telemetry: true\n", cond = "", strategy = "" } = {}) => `name: CI
on: [pull_request]
permissions:
  contents: read
jobs:
  build:
    runs-on: ${runsOn}
${strategy}    steps:
      - uses: step-security/harden-runner@${HARDEN} # v2.22.3
${cond}        with:
${egress === null ? "" : `          egress-policy: ${egress}\n`}${telemetry ? `    ${telemetry}` : ""}          allowed-endpoints: >
            github.com:443
      - uses: actions/checkout@${SHA} # v7.0.1
      - run: echo ok
`;

test("harden-runner in block mode with telemetry off on a Linux job passes", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened() });
  assert.equal(r.code, 0, r.out);
});

test("harden-runner in audit mode fails", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ egress: "audit" }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ci\.yml:\d+: harden-runner with egress-policy: audit/);
});

test("harden-runner without an egress policy runs in audit mode, its default, and fails", () => {
  const r = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ egress: null }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /without egress-policy: block runs in audit mode/);
});

test("harden-runner without disable-telemetry: true fails", () => {
  const off = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ telemetry: "" }) });
  assert.equal(off.code, 1, off.out);
  assert.match(off.out, /without disable-telemetry: true/);
  const no = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ telemetry: "      disable-telemetry: false\n" }) });
  assert.equal(no.code, 1, no.out);
});

test("harden-runner in a Windows or macOS job fails", () => {
  for (const runsOn of ["windows-2025", "macos-15"]) {
    const r = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ runsOn }) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`harden-runner in a job that runs on ${runsOn}`));
  }
});

test("harden-runner in a matrix job needs runner.os == 'Linux' in its if", () => {
  const runsOn = "${{ matrix.os }}";
  // A Linux and macOS matrix: with a Windows leg the job's `run: echo ok` would run under pwsh and need its opt-out.
  const strategy = "    strategy:\n      matrix:\n        os: [ubuntu-24.04, macos-15]\n";
  const bare = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ runsOn, strategy }) });
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.out, /without runner\.os == 'Linux' in the step's if/);
  const guarded = check({ ...COMPLETE, ".github/workflows/ci.yml": hardened({ runsOn, strategy, cond: "        if: ${{ runner.os == 'Linux' && github.event.repository.visibility == 'public' }}\n" }) });
  assert.equal(guarded.code, 0, guarded.out);
});

// The telemetry opt-outs of the CI's own tools (PG-D14; B0-U02's docNote D18, with clause (3) as its round-4 inspection
// corrected it). A step's env is the workflow's, then the job's, then the step's own; a composite action's step has only
// its own. Built as text so each case changes one thing.
const envBlock = (indent, env) =>
  env ? `${" ".repeat(indent)}env:\n${Object.entries(env).map(([k, v]) => `${" ".repeat(indent + 2)}${k}: ${JSON.stringify(v)}\n`).join("")}` : "";
const tStep = ({ run, shell, env, uses, name = "Step" }) =>
  `      - name: ${name}\n${uses ? `        uses: ${uses}\n` : ""}${shell ? `        shell: ${shell}\n` : ""}${envBlock(8, env)}` +
  (run === undefined ? "" : `        run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`);
const tJob = ({ id = "work", runsOn = "ubuntu-24.04", strategy = "", env, defaults, steps }) =>
  `  ${id}:\n    runs-on: ${runsOn}\n${strategy}${envBlock(4, env)}${defaults ? `    defaults:\n      run:\n        shell: ${defaults}\n` : ""}    steps:\n${steps.join("")}`;
const tWorkflow = ({ env, defaults, jobs }) =>
  `name: T\non: [pull_request]\npermissions:\n  contents: read\n${envBlock(0, env)}${defaults ? `defaults:\n  run:\n    shell: ${defaults}\n` : ""}jobs:\n${jobs.join("")}`;
const tele = (workflow, extra = {}) => check({ "README.md": "# Me\n", ".github/workflows/ci.yml": workflow, ...extra }, "profile");
// The findings of one kind ("gh", "pnpm or turbo", "pwsh") that a run names in ci.yml, each as "job:line", sorted; and
// the line of the step a case names (its `- name:` line, which is the line the check reports). With them a case pins
// which steps of which jobs were named, and where: any step of a job, in any job of the workflow (B0-U01).
const named = (out, kind) =>
  [...out.matchAll(new RegExp(`^- \\.github/workflows/ci\\.yml:(\\d+): (?:a step that runs ${kind} \\(jobs\\.([\\w-]+)\\)|job ([\\w-]+) runs ${kind} \\()`, "gm"))]
    .map((m) => `${m[2] ?? m[3]}:${m[1]}`)
    .sort();
const lineOf = (text, name) => {
  const i = text.split("\n").indexOf(`      - name: ${name}`);
  assert.ok(i >= 0, `no step named ${name}`);
  return i + 1;
};
// A step that uses a remote action, as the first steps of a real job do (checkout, setup-node and the like).
const remote = (name) => tStep({ uses: `actions/${name}@${SHA}` });

test("telemetry (1): a step that runs gh needs GH_TELEMETRY set to a falsey value, or DO_NOT_TRACK with GH_TELEMETRY unset (PG-D14; B0-U01)", () => {
  const gh = (o = {}) => tWorkflow({ env: o.top, jobs: [tJob({ env: o.job, steps: [tStep({ run: o.run ?? 'set -e\ngh release view "$TAG" --json assets', env: o.step })] })] });
  const fails = {
    "no opt-out": gh(),
    "GH_TELEMETRY: log, which DO_NOT_TRACK does not override": gh({ top: { DO_NOT_TRACK: "1" }, step: { GH_TELEMETRY: "log" } }),
    "GH_TELEMETRY: enabled": gh({ job: { GH_TELEMETRY: "enabled" } }),
    "DO_NOT_TRACK: 0": gh({ top: { DO_NOT_TRACK: "0" } }),
    "gh inside a command substitution": gh({ run: "n=$(gh api repos/o/r/releases --jq length)" }),
    "gh after &&": gh({ run: "cd out && gh attestation verify app.zip -R o/r" }),
    "gh workflow": gh({ run: "gh workflow run nightly.yml --ref main" }),
    "gh secret": gh({ run: "gh secret list -R o/r" }),
    // An echo's text ends at the next ; & or |, and a comment line ends at its line (B0-U01, inspection 4: N2, N1).
    "gh after an echo and a ; on the same line": gh({ run: 'echo start; gh release view "$TAG"' }),
    "gh after a comment line": gh({ run: '# read the release\ngh release view "$TAG"' }),
    "gh after an echo and a |": gh({ run: 'echo "$BODY" | gh issue comment 1 --body-file -' }),
    "gh after an echo and &&": gh({ run: 'echo start && gh release view "$TAG"' }),
    // A command substitution in an echo's or printf's text runs before it prints, so it is code: the usual way to set
    // a step output (B0-U01, inspection 6: B2). Single quotes close, a quote inside double quotes is text, a backslash
    // escapes the next character, and a $( ) span ends at its matching ).
    "gh in a command substitution in an echo, as a step output": gh({ run: 'echo "tag=$(gh release view --json tagName --jq .tagName)" >> "$GITHUB_OUTPUT"' }),
    "gh in a command substitution after a printf's single-quoted format": gh({ run: "printf 'open issues: %s\\n' \"$(gh issue list --json number --jq length)\"" }),
    "gh in backticks in an echo": gh({ run: 'echo "n=`gh api repos/o/r/releases --jq length`"' }),
    "gh in a command substitution after a quote inside double quotes": gh({ run: `echo "it's $(gh release view "$TAG" --json name --jq .name)"` }),
    "gh in a command substitution after an escaped quote": gh({ run: `echo don\\'t "$(gh release view "$TAG")"` }),
    "gh after a nested command substitution, in the same one": gh({ run: 'echo "notes=$(GH_REPO=$(cat repo) gh release view "$TAG")"' }),
    // A |, ||, ; or && inside a substitution ends the echo's text before the substitution closes, and the part before it
    // still runs (B0-U01, inspection 7: N3, N3a, N4). A backslash in single quotes is text (N1); in $'...' it escapes a
    // quote, and a # inside quotes or inside a word starts no comment (n4).
    "gh in a command substitution piped to jq, as a step output": gh({ run: 'echo "count=$(gh issue list --json number | jq length)" >> "$GITHUB_OUTPUT"' }),
    "gh in a command substitution with || after it": gh({ run: 'echo "name=$(gh release view "$TAG" --json name --jq .name || echo none)" >> "$GITHUB_OUTPUT"' }),
    "gh in a command substitution with ; after it": gh({ run: 'echo "login=$(gh api user --jq .login; true)"' }),
    "gh in a command substitution with && after it": gh({ run: 'echo "ok=$(gh auth status && echo yes)" >> "$GITHUB_OUTPUT"' }),
    "gh in backticks piped to wc": gh({ run: 'echo "count=`gh issue list --json number --jq .[] | wc -l`"' }),
    "gh in a command substitution after a single-quoted text that ends in a backslash": gh({ run: "echo 'Saved to C:\\temp\\' \"$(gh release view \"$TAG\" --json name --jq .name)\"" }),
    "gh in a command substitution after an ANSI-C quoted text with an escaped quote": gh({ run: "echo $'it\\'s' \"$(gh api user --jq .login)\"" }),
    "gh in a command substitution after a # inside double quotes": gh({ run: 'echo "issue #$(gh issue list --json number --jq .[0].number)"' }),
    "gh in a command substitution after a # inside a word": gh({ run: "echo run#$(gh run list --limit 1 --json number --jq .[0].number)" }),
  };
  // Every subcommand the rule lists, each in a step of its own (inspection 6: S1, S2, S6).
  for (const run of ["gh api rate_limit", 'gh release view "$TAG"', "gh issue create --title t --body b", "gh label create triage", "gh run list --limit 1", "gh pr view 1", "gh workflow run nightly.yml", "gh repo view o/r", "gh auth status", "gh attestation verify app.zip -R o/r", "gh search issues telemetry", "gh cache list", "gh secret list", "gh variable list"]) {
    fails[run] = gh({ run });
  }
  for (const [why, text] of Object.entries(fails)) {
    const r = tele(text);
    assert.equal(r.code, 1, `${why}: ${r.out}`);
    assert.match(r.out, /ci\.yml:\d+: a step that runs gh \(jobs\.work\) has no telemetry opt-out/, why);
  }
  // A workflow named .yaml is read as one named .yml is (inspection 4: N3).
  const bare = gh();
  const yaml = check({ "README.md": "# Me\n", ".github/workflows/ci.yaml": bare }, "profile");
  assert.equal(yaml.code, 1, yaml.out);
  assert.match(yaml.out, new RegExp(`^- \\.github/workflows/ci\\.yaml:${lineOf(bare, "Step")}: a step that runs gh \\(jobs\\.work\\)`, "m"));
  // A job whose steps: is an alias of another job's (steps: *shared) runs those steps, and is named at their line; the
  // job with the anchor has its own opt-out (inspection 4: N12).
  const shared = tWorkflow({
    jobs: [tJob({ id: "first", env: { GH_TELEMETRY: "0" }, steps: [tStep({ name: "Shared", run: "gh pr view 1" })] }).replace("    steps:\n", "    steps: &shared\n"), "  work:\n    runs-on: ubuntu-24.04\n    steps: *shared\n"],
  });
  const sh = tele(shared);
  assert.equal(sh.code, 1, sh.out);
  assert.deepEqual(named(sh.out, "gh"), [`work:${lineOf(shared, "Shared")}`], sh.out);
  // Another job's opt-out does not reach this one.
  const other = tele(tWorkflow({ jobs: [tJob({ id: "first", env: { GH_TELEMETRY: "0" }, steps: [tStep({ run: "gh pr view 1" })] }), tJob({ steps: [tStep({ run: "gh pr view 1" })] })] }));
  assert.equal(other.code, 1, other.out);
  assert.match(other.out, /\(jobs\.work\)/);
  assert.doesNotMatch(other.out, /\(jobs\.first\)/);
  // Any step of any job: the gh step sits in the middle of the second of three jobs, behind two uses: steps and a run:
  // step, with a run: step and an action after it, as in a real job whose first step is harden-runner or checkout.
  const middle = tWorkflow({
    jobs: [
      tJob({ id: "first", steps: [remote("checkout"), tStep({ run: "make build" })] }),
      tJob({ steps: [remote("checkout"), remote("setup-node"), tStep({ run: "make build" }), tStep({ name: "Offender", run: 'gh release view "$TAG" --json assets' }), tStep({ run: "make test" }), remote("upload-artifact")] }),
      tJob({ id: "last", steps: [tStep({ run: "make lint" })] }),
    ],
  });
  const mid = tele(middle);
  assert.equal(mid.code, 1, mid.out);
  assert.deepEqual(named(mid.out, "gh"), [`work:${lineOf(middle, "Offender")}`], mid.out);
  // Every gh step without the opt-out is named, at its own line and in every job, whatever the gh steps before and
  // after it set in their own env; two in one job are both named.
  const each = tWorkflow({
    jobs: [
      tJob({ steps: [remote("checkout"), tStep({ name: "Own opt-out before", run: "gh pr view 1", env: { GH_TELEMETRY: "0" } }), tStep({ name: "Offender", run: "gh pr view 2" }), tStep({ name: "Own opt-out after", run: "gh pr view 3", env: { GH_TELEMETRY: "0" } }), tStep({ name: "Second offender", run: "gh pr view 5" })] }),
      tJob({ id: "later", steps: [remote("checkout"), tStep({ name: "Offender in a later job", run: "gh pr view 4" })] }),
    ],
  });
  const all = tele(each);
  assert.equal(all.code, 1, all.out);
  assert.deepEqual(named(all.out, "gh"), [`later:${lineOf(each, "Offender in a later job")}`, `work:${lineOf(each, "Offender")}`, `work:${lineOf(each, "Second offender")}`].sort(), all.out);
  // A gh step whose `- ` line holds only its anchor (its keys on the lines below, as ci-rust.yml lays out its anchored
  // steps), and the alias of that step in a later job: each is named at its own `- ` line, not at the line of the
  // step's first key (B0-U01, round 4: the closing round's Z18, which only round 3's invented release.yml step killed).
  const anchored = tWorkflow({
    jobs: [
      tJob({ id: "first", steps: [remote("checkout"), '      - &notes\n        name: Notes\n        run: gh release view "$TAG"\n'] }),
      tJob({ steps: [remote("checkout"), "      - *notes\n"] }),
    ],
  });
  const itemLine = (text, line) => text.split("\n").indexOf(line) + 1;
  const anc = tele(anchored);
  assert.equal(anc.code, 1, anc.out);
  assert.deepEqual(named(anc.out, "gh"), [`first:${itemLine(anchored, "      - &notes")}`, `work:${itemLine(anchored, "      - *notes")}`].sort(), anc.out);
  const passes = {
    "workflow GH_TELEMETRY 0": gh({ top: { GH_TELEMETRY: "0" } }),
    "job GH_TELEMETRY false": gh({ job: { GH_TELEMETRY: "false" } }),
    "step GH_TELEMETRY empty": gh({ step: { GH_TELEMETRY: "" } }),
    "step GH_TELEMETRY Off": gh({ step: { GH_TELEMETRY: "Off" } }),
    "DO_NOT_TRACK true with GH_TELEMETRY unset": gh({ top: { DO_NOT_TRACK: "true" } }),
    "the step's GH_TELEMETRY 0 over the workflow's log": gh({ top: { GH_TELEMETRY: "log" }, step: { GH_TELEMETRY: "0" } }),
    "the job's GH_TELEMETRY 0 over the workflow's enabled": gh({ top: { GH_TELEMETRY: "enabled" }, job: { GH_TELEMETRY: "0" } }),
    "gh only in comments and messages": gh({ run: '# gh release upload is the next step\necho "run gh release view to check"\nprintf \'%s\\n\' "gh api failed"' }),
    // ... and in an echo's text that is not a command substitution: in single quotes, after an escaped $, and after a
    // substitution that ran something else has closed (inspection 6: B2).
    "gh named in single quotes after a double-quoted word in an echo": gh({ run: "echo \"Run:\" 'gh release view, or $(gh release view)'" }),
    "gh named after an escaped $ in an echo": gh({ run: 'echo "\\$(gh api rate_limit) shows the limit"' }),
    "gh named after a command substitution that ran date": gh({ run: 'echo "$(date -u) gh release view comes next"' }),
    // A double quote inside single quotes is text (inspection 7: N2), and an unquoted # that starts a word begins a
    // comment, which the shell does not run (n4).
    "gh named in a single-quoted text that holds double quotes": gh({ run: "echo 'Run \"$(gh auth login)\" first'" }),
    "gh in a comment after an echo": gh({ run: "echo hi # $(gh api user)" }),
    // gh reads both variables trimmed and lower-cased: strings.TrimSpace(strings.ToLower(envVal)) in ParseTelemetryState
    // (cli/cli internal/telemetry/telemetry.go), unlike turbo in telemetry (2).
    "GH_TELEMETRY ' 0 ', which gh trims": gh({ step: { GH_TELEMETRY: " 0 " } }),
    "DO_NOT_TRACK ' TRUE ' with GH_TELEMETRY unset, which gh trims and lower-cases": gh({ top: { DO_NOT_TRACK: " TRUE " } }),
  };
  for (const [why, text] of Object.entries(passes)) {
    const r = tele(text);
    assert.equal(r.code, 0, `${why}: ${r.out}`);
  }
});

test("telemetry (2): a step that runs pnpm or turbo needs DO_NOT_TRACK or TURBO_TELEMETRY_DISABLED set to 1 or true (PG-D14; B0-U01)", () => {
  const js = (o = {}) => tWorkflow({ env: o.top, jobs: [tJob({ env: o.job, steps: [tStep({ run: o.run ?? "pnpm install --frozen-lockfile\npnpm build", env: o.step })] })] });
  const fails = {
    "no opt-out": js(),
    "turbo through npx": js({ run: "npx turbo run build" }),
    "DO_NOT_TRACK: 0": js({ job: { DO_NOT_TRACK: "0" } }),
    "TURBO_TELEMETRY_DISABLED: no": js({ step: { TURBO_TELEMETRY_DISABLED: "no" } }),
    // turbo turns its telemetry off only on exactly "1" or "true", in that case: is_disabled_by_env is
    // matches!(env::var(name).as_deref(), Ok("1" | "true")) for both variables (turborepo-telemetry config.rs).
    "DO_NOT_TRACK: TRUE, which turbo does not read as true": js({ top: { DO_NOT_TRACK: "TRUE" } }),
    "TURBO_TELEMETRY_DISABLED: True, which turbo does not read as true": js({ job: { TURBO_TELEMETRY_DISABLED: "True" } }),
    // The nearer scope wins in both directions: a step's 0 under the workflow's 1 turns it back on (inspection 4: E2).
    "the step's DO_NOT_TRACK 0 under the workflow's 1": js({ top: { DO_NOT_TRACK: "1" }, step: { DO_NOT_TRACK: "0" } }),
    // ... and does not trim it (inspection 6: S10).
    "DO_NOT_TRACK ' 1', which turbo does not trim": js({ top: { DO_NOT_TRACK: " 1" } }),
    "TURBO_TELEMETRY_DISABLED 'true ', which turbo does not trim": js({ job: { TURBO_TELEMETRY_DISABLED: "true " } }),
    // pnpm in a command substitution, alone (S7) and in an echo's text, as pnpm's own caching recipe writes it (B2).
    "pnpm in a command substitution": js({ run: 'n="$(pnpm -s exec tsc --version)"' }),
    "pnpm in a command substitution in an echo": js({ run: 'echo "STORE_PATH=$(pnpm store path --silent)" >> "$GITHUB_ENV"' }),
  };
  for (const [why, text] of Object.entries(fails)) {
    const r = tele(text);
    assert.equal(r.code, 1, `${why}: ${r.out}`);
    assert.match(r.out, /ci\.yml:\d+: a step that runs pnpm or turbo \(jobs\.work\) has neither DO_NOT_TRACK nor TURBO_TELEMETRY_DISABLED/, why);
  }
  // Any step of any job, as in telemetry (1): the pnpm step in the middle of the second of three jobs, behind uses: and
  // run: steps; then every such step named, at its own line and in every job, whatever its neighbours set in their env.
  const middle = tWorkflow({
    jobs: [
      tJob({ id: "first", steps: [remote("checkout"), tStep({ run: "make build" })] }),
      tJob({ steps: [remote("checkout"), remote("setup-node"), tStep({ run: "make build" }), tStep({ name: "Offender", run: "pnpm build" }), tStep({ run: "make test" }), remote("upload-artifact")] }),
      tJob({ id: "last", steps: [tStep({ run: "make lint" })] }),
    ],
  });
  const mid = tele(middle);
  assert.equal(mid.code, 1, mid.out);
  assert.deepEqual(named(mid.out, "pnpm or turbo"), [`work:${lineOf(middle, "Offender")}`], mid.out);
  const each = tWorkflow({
    jobs: [
      tJob({ steps: [remote("checkout"), tStep({ name: "Own opt-out before", run: "pnpm install", env: { DO_NOT_TRACK: "1" } }), tStep({ name: "Offender", run: "npx turbo run build" }), tStep({ name: "Own opt-out after", run: "pnpm test", env: { TURBO_TELEMETRY_DISABLED: "1" } })] }),
      tJob({ id: "later", steps: [remote("checkout"), tStep({ name: "Offender in a later job", run: "pnpm lint" })] }),
    ],
  });
  const all = tele(each);
  assert.equal(all.code, 1, all.out);
  assert.deepEqual(named(all.out, "pnpm or turbo"), [`later:${lineOf(each, "Offender in a later job")}`, `work:${lineOf(each, "Offender")}`], all.out);
  const passes = {
    "workflow DO_NOT_TRACK 1": js({ top: { DO_NOT_TRACK: "1" } }),
    "job TURBO_TELEMETRY_DISABLED true": js({ job: { TURBO_TELEMETRY_DISABLED: "true" } }),
    "step DO_NOT_TRACK true": js({ step: { DO_NOT_TRACK: "true" } }),
    "pnpm only in a comment": js({ run: "# pnpm install comes later\nnode --version" }),
  };
  for (const [why, text] of Object.entries(passes)) {
    const r = tele(text);
    assert.equal(r.code, 0, `${why}: ${r.out}`);
  }
});

test("telemetry (3): a job that runs pwsh, by the effective shell of its run steps on every runner its runs-on or matrix can produce, needs POWERSHELL_TELEMETRY_OPTOUT (PG-D14; B0-U01)", async () => {
  const plain = [tStep({ run: "node --version" })];
  const matrix = (body) => `    strategy:\n      matrix:\n${body}`;
  // A local composite action, given as [workflow, extra files]: one with a pwsh step, one with bash steps only, and one
  // the reader cannot read (a merge key), which sits outside .github/actions so that only the pwsh rule reports it.
  const action = (shell) => `name: Tool\ndescription: Runs a tool.\nruns:\n  using: composite\n  steps:\n    - name: Run\n      shell: ${shell}\n      run: ls\n`;
  const onWindows = (uses) => tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", defaults: "bash", steps: [tStep({ uses })] })] });
  // A local action whose only step uses another local action, and a chain of n of them whose last has bash steps only.
  const nest = (uses) => `name: Outer\ndescription: Uses a local action.\nruns:\n  using: composite\n  steps:\n    - uses: ${uses}\n`;
  const chain = (n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`.github/actions/a${k + 1}/action.yml`, k + 1 < n ? nest(`./.github/actions/a${k + 2}`) : action("bash")]));
  const fails = {
    "shell: pwsh on Linux": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "Get-ChildItem", shell: "pwsh" })] })] }),
    "a shell: the check cannot read (an expression)": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "ls", shell: "${{ matrix.shell }}" })] })] }),
    "shell: powershell": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "dir", shell: "powershell" })] })] }),
    "a step with no shell on windows-2025, whose default is pwsh": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: plain })] }),
    "the workflow's defaults.run.shell pwsh": tWorkflow({ defaults: "pwsh", jobs: [tJob({ steps: plain })] }),
    "the job's defaults.run.shell pwsh over the workflow's bash": tWorkflow({ defaults: "bash", jobs: [tJob({ defaults: "pwsh", steps: plain })] }),
    "a matrix list with windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix("        os: [ubuntu-24.04, windows-2025]\n"), steps: plain })] }),
    "a matrix include with windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix("        include:\n          - { os: windows-2025, part: a }\n          - os: ubuntu-24.04\n            part: b\n"), steps: plain })] }),
    "a fromJSON list with windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix(`        os: \${{ fromJSON(github.event_name == 'pull_request' && '["ubuntu-24.04"]' || '["ubuntu-24.04","windows-2025"]') }}\n`), steps: plain })] }),
    "a fromJSON whose windows-2025 leg is in its first list only": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix(`        os: \${{ fromJSON(github.event_name == 'pull_request' && '["windows-2025","ubuntu-24.04"]' || '["ubuntu-24.04"]') }}\n`), steps: plain })] }),
    "a runs-on read from a repository variable through fromJSON, which the check cannot resolve": tWorkflow({ jobs: [tJob({ runsOn: "${{ fromJSON(vars.RUNNERS) }}", steps: plain })] }),
    "a runs-on that names a matrix key the matrix does not define": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.runner }}", strategy: matrix("        os: [ubuntu-24.04, macos-15]\n"), steps: plain })] }),
    "a matrix include entry that is not a mapping, which the check cannot read": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix("        os: [ubuntu-24.04]\n        include:\n          - windows-2025\n"), steps: plain })] }),
    "a runner the check cannot resolve": tWorkflow({ jobs: [tJob({ runsOn: "${{ vars.RUNNER }}", steps: plain })] }),
    "a self-hosted runner whose labels name no OS": tWorkflow({ jobs: [tJob({ runsOn: "[self-hosted, x64]", steps: plain })] }),
    "the toxiproxy action on windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", defaults: "bash", steps: [tStep({ uses: "./.github/actions/toxiproxy" })] })] }),
    "the standard-user action on windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", defaults: "bash", steps: [tStep({ uses: "./.github/actions/standard-user" })] })] }),
    "the toxiproxy action named with a trailing slash": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", defaults: "bash", steps: [tStep({ uses: "./.github/actions/toxiproxy/" })] })] }),
    "POWERSHELL_TELEMETRY_OPTOUT: 0": tWorkflow({ env: { POWERSHELL_TELEMETRY_OPTOUT: "0" }, jobs: [tJob({ runsOn: "windows-2025", steps: plain })] }),
    // A job runs pwsh when ANY of its run: steps does; the first step of a real job is harden-runner or checkout.
    "a pwsh step after a step that is not one": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "ls", shell: "bash" }), tStep({ run: "node --version" })] })] }),
    "a second pwsh step without the opt-out the first step sets in its own env": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "a", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" } }), tStep({ run: "b" })] })] }),
    "the step's shell: pwsh over the workflow's defaults.run.shell bash": tWorkflow({ defaults: "bash", jobs: [tJob({ steps: [tStep({ run: "Get-ChildItem", shell: "pwsh" })] })] }),
    "a shell: whose command is pwsh, with arguments": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "Get-ChildItem", shell: `pwsh -NoLogo -command ". '{0}'"` })] })] }),
    "a local composite action with a pwsh step on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yml": action("pwsh") }],
    "a local composite action in action.yaml with a pwsh step on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yaml": action("pwsh") }],
    "a local action the reader cannot read, on windows-2025": [onWindows("./tools/broken"), { "tools/broken/action.yml": "base: &b\n  using: composite\nruns:\n  <<: *b\n  steps: []\n" }],
    "a job with no runs-on, which the check cannot resolve": tWorkflow({ jobs: [tJob({ steps: plain }).replace("    runs-on: ubuntu-24.04\n", "")] }),
    // pwsh 7.6.10 reads the variable as true only when it is exactly 1, or yes or true in any case, untrimmed
    // (src/System.Management.Automation/engine/Utils.cs, GetEnvironmentVariableAsBool, lines 1603-1661; Telemetry.cs
    // passes defaultValue: false, so any other value leaves telemetry on).
    "POWERSHELL_TELEMETRY_OPTOUT: 10, which pwsh does not read as true": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: "10" }, steps: plain })] }),
    // Inspection 4 of B0-U01: the nearer scope's 0 under a farther 1 (E1); a matrix list beside include entries, all of
    // which count (N5); a nested matrix path that one entry lacks, which the check cannot resolve (N10); a composite
    // action's shell: powershell step (N9); a self-hosted runner labelled Windows that also names Linux (P17).
    "the job's opt-out 0 under the workflow's 1": tWorkflow({ env: { POWERSHELL_TELEMETRY_OPTOUT: "1" }, jobs: [tJob({ runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: "0" }, steps: plain })] }),
    "a matrix list with windows-2025 beside an include entry": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix('        os: [windows-2025, ubuntu-24.04]\n        include:\n          - os: ubuntu-24.04\n            coverage: "true"\n'), steps: plain })] }),
    "a nested matrix path that one entry lacks": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.target.runner }}", strategy: matrix("        target:\n          - runner: ubuntu-24.04\n          - name: other\n"), steps: plain })] }),
    "a local composite action with a shell: powershell step on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yml": action("powershell") }],
    "a self-hosted Windows runner with a label that names Linux": tWorkflow({ jobs: [tJob({ runsOn: "[self-hosted, Windows, X64, wsl-ubuntu]", steps: plain })] }),
    // Inspection 6 of B0-U01: pwsh started as a command from a run: script, on any runner (m3), at the script's start,
    // in a command substitution, as PowerShell.exe from Git Bash, and in a local action's bash step; an untrimmed
    // opt-out (S11); a runs-on whose expression names Linux inside other text, read by its text alone (S14).
    "a bash step on Linux whose script starts pwsh": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'pwsh -NoProfile -Command "Invoke-Pester -CI"' })] })] }),
    "a bash step whose script runs pwsh in a command substitution": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "v=\"$(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')\"" })] })] }),
    "a shell: bash step on windows-2025 whose script starts PowerShell.exe": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "PowerShell.exe -NoProfile -File build.ps1", shell: "bash" })] })] }),
    "a local composite action whose bash step starts pwsh, on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yml": action("bash").replace("run: ls", "run: pwsh -File tool.ps1") }],
    "POWERSHELL_TELEMETRY_OPTOUT ' 1', which pwsh does not trim": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: " 1" }, steps: plain })] }),
    "a runs-on whose expression names Linux inside other text": tWorkflow({ jobs: [tJob({ runsOn: "${{ vars.LINUX_POOL }}-x64", steps: plain })] }),
    // Inspection 7 of B0-U01: pwsh by an absolute path, in quotes where the path holds a space, in quotes after bash -c
    // or sh -c, before a heredoc, after a backtick, after $ (a variable named pwsh), glued after ;, | or &&, and as the
    // script's last word (N10, N11, N11b, N12; n2); a local composite action with a pwsh step, or one the reader cannot
    // read, used on Linux (n2); a label of the list or group form that is only an expression, which names no OS (n3).
    "a bash step that starts /usr/bin/pwsh": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "/usr/bin/pwsh -File build.ps1" })] })] }),
    "a bash step that starts pwsh by its install path": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "/opt/microsoft/powershell/7/pwsh -NoProfile -Command Get-Date" })] })] }),
    "a shell: bash step on windows-2025 that starts pwsh.exe by a quoted path with a space": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: '"C:/Program Files/PowerShell/7/pwsh.exe" -File build.ps1', shell: "bash" })] })] }),
    "pwsh in double quotes after bash -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'bash -c "pwsh -NoProfile -Command Get-Date"' })] })] }),
    "pwsh in single quotes after sh -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "sh -c 'pwsh -File build.ps1'" })] })] }),
    "pwsh in quotes after bash -e -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'bash -e -c "pwsh -File build.ps1"' })] })] }),
    "pwsh in quotes after /bin/sh -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "/bin/sh -c 'pwsh -File build.ps1'" })] })] }),
    "a shell: cmd step on windows-2025 that starts pwsh.exe by its path": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "C:\\tools\\pwsh.exe -File build.ps1", shell: "cmd" })] })] }),
    "pwsh before a heredoc": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "pwsh<<'EOF'\nGet-Date\nEOF" })] })] }),
    "pwsh after a backtick": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "v=`pwsh -NoProfile -Command Get-Date`" })] })] }),
    "pwsh by a variable named for it": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: '"$PWSH" -NoProfile -File build.ps1' })] })] }),
    "pwsh glued after ;": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "make x;pwsh -File build.ps1" })] })] }),
    "pwsh glued after |": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "cat build.ps1|pwsh -Command -" })] })] }),
    "pwsh glued after &&": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "make x&&pwsh -File build.ps1" })] })] }),
    // A one-line run: is a plain scalar, which ends with no line break.
    "pwsh as the last word of a one-line script": tWorkflow({ jobs: [tJob({ steps: ["      - name: Step\n        run: cat build.ps1 | pwsh\n"] })] }),
    "a local composite action with a pwsh step, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/tool" })] })] }), { ".github/actions/tool/action.yml": action("pwsh") }],
    "a local composite action whose bash step starts pwsh, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/tool" })] })] }), { ".github/actions/tool/action.yml": action("bash").replace("run: ls", "run: pwsh -File tool.ps1") }],
    "a local action the reader cannot read, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./tools/broken" })] })] }), { "tools/broken/action.yml": "base: &b\n  using: composite\nruns:\n  <<: *b\n  steps: []\n" }],
    "a self-hosted list whose label is only an expression": tWorkflow({ jobs: [tJob({ runsOn: '[self-hosted, "${{ vars.LINUX_POOL }}"]', steps: plain })] }),
    "a runner group whose labels hold only an expression": tWorkflow({ jobs: [tJob({ runsOn: '{ group: pool, labels: ["${{ vars.LINUX_POOL }}"] }', steps: plain })] }),
    "a runner group whose labels are one expression": tWorkflow({ jobs: [tJob({ runsOn: '{ group: pool, labels: "${{ vars.LINUX_POOL }}" }', steps: plain })] }),
    // Inspection 8 of B0-U01: pwsh in quotes after bash -lc (M1), -o pipefail -c, --login -c and +o posix -c; pwsh.exe by
    // a single-quoted path with a space (M2); pwsh as a .NET global tool ($HOME or ~) or from its release archive
    // (./pwsh7/pwsh) (p1); a label the matrix gives, or an include entry's label list, that is only an expression (p2);
    // a local action that uses a local action with a pwsh step, and a chain deeper than the check follows (p3).
    "pwsh in quotes after bash -lc": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'bash -lc "pwsh -File build.ps1"' })] })] }),
    "pwsh in quotes after bash -o pipefail -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'bash -o pipefail -c "pwsh -File build.ps1"' })] })] }),
    "pwsh in quotes after bash --login -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'bash --login -c "pwsh -File build.ps1"' })] })] }),
    "pwsh in quotes after bash +o posix -c": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "bash +o posix -c 'pwsh -File build.ps1'" })] })] }),
    "a shell: bash step on windows-2025 that starts pwsh.exe by a single-quoted path with a space": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "'C:/Program Files/PowerShell/7/pwsh.exe' -File build.ps1", shell: "bash" })] })] }),
    "pwsh by a path in double quotes, with no space in it": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: '"/opt/microsoft/powershell/7/pwsh" -File build.ps1' })] })] }),
    "pwsh by a path in single quotes, with no space in it": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "'./pwsh7/pwsh' -File build.ps1" })] })] }),
    "pwsh as a .NET global tool, by a quoted $HOME path": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: '"$HOME/.dotnet/tools/pwsh" -File build.ps1' })] })] }),
    "pwsh as a .NET global tool, by a ~ path": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "~/.dotnet/tools/pwsh -File build.ps1" })] })] }),
    "pwsh from its release archive, by a ./ path": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "tar -xzf powershell-linux-x64.tar.gz -C pwsh7\n./pwsh7/pwsh -File build.ps1" })] })] }),
    "a matrix label that is only an expression": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.runner }}", strategy: matrix('        runner: ["${{ vars.LINUX_POOL }}"]\n'), steps: plain })] }),
    "an include entry whose label list holds only an expression beside self-hosted": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.runner }}", strategy: matrix('        include:\n          - runner: [self-hosted, "${{ vars.LINUX_POOL }}"]\n'), steps: plain })] }),
    "a local action that uses a local action with a pwsh step, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/outer" })] })] }), { ".github/actions/outer/action.yml": nest("./.github/actions/tool"), ".github/actions/tool/action.yml": action("pwsh") }],
    "a chain of eleven local actions with bash steps only, deeper than the check follows": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/a1" })] })] }), chain(11)],
  };
  const withFiles = (v) => (Array.isArray(v) ? v : [v, {}]);
  for (const [why, v] of Object.entries(fails)) {
    const r = tele(...withFiles(v));
    assert.equal(r.code, 1, `${why}: ${r.out}`);
    assert.match(r.out, /ci\.yml:\d+: job work runs pwsh \(.+\) without POWERSHELL_TELEMETRY_OPTOUT/, why);
  }
  // Any step of any job. The pwsh step (no shell on windows-2025) sits in the middle of the second of three jobs: after a
  // bash step and two uses: steps, before a bash step and an action. The check names the job at that step's line.
  const middle = tWorkflow({
    jobs: [
      tJob({ id: "first", steps: plain }),
      tJob({ runsOn: "windows-2025", steps: [tStep({ run: "ls", shell: "bash" }), remote("checkout"), remote("setup-node"), tStep({ name: "Offender", run: "node --version" }), tStep({ run: "ls", shell: "bash" }), remote("upload-artifact")] }),
      tJob({ id: "last", steps: plain }),
    ],
  });
  const mid = tele(middle);
  assert.equal(mid.code, 1, mid.out);
  assert.deepEqual(named(mid.out, "pwsh"), [`work:${lineOf(middle, "Offender")}`], mid.out);
  // A local pwsh action in the middle of a bash job that is not first, behind checkout and a run: step.
  const local = tWorkflow({
    jobs: [
      tJob({ id: "first", steps: plain }),
      tJob({ runsOn: "windows-2025", defaults: "bash", steps: [remote("checkout"), tStep({ run: "ls" }), tStep({ name: "Offender", uses: "./.github/actions/toxiproxy" }), tStep({ run: "ls" })] }),
    ],
  });
  const loc = tele(local);
  assert.equal(loc.code, 1, loc.out);
  assert.deepEqual(named(loc.out, "pwsh"), [`work:${lineOf(local, "Offender")}`], loc.out);
  // Every job that runs pwsh without the opt-out is named, once, at its first such step: not at a pwsh step before it
  // that sets the opt-out in its own env, nor at a second one after it; a later step's own opt-out does not excuse an
  // earlier step, and the first job's opt-out does not reach the jobs after it.
  const each = tWorkflow({
    jobs: [
      tJob({ id: "first", runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" }, steps: plain }),
      tJob({ runsOn: "windows-2025", steps: [remote("checkout"), tStep({ name: "Own opt-out before", run: "z", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" } }), tStep({ name: "Offender", run: "a" }), tStep({ name: "Own opt-out after", run: "b", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" } }), tStep({ name: "Second offender", run: "d" })] }),
      tJob({ id: "later", runsOn: "windows-2025", steps: [remote("checkout"), tStep({ name: "Offender in a later job", run: "c" })] }),
    ],
  });
  const all = tele(each);
  assert.equal(all.code, 1, all.out);
  assert.deepEqual(named(all.out, "pwsh"), [`later:${lineOf(each, "Offender in a later job")}`, `work:${lineOf(each, "Offender")}`], all.out);
  const passes = {
    "no shell on Linux and macOS legs": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix("        os: [ubuntu-24.04, macos-15]\n"), steps: plain })] }),
    "no shell on the Linux and macOS legs of a matrix include": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix("        include:\n          - { os: ubuntu-24.04, part: a }\n          - os: macos-15\n            part: b\n"), steps: plain })] }),
    "no shell on the Linux and macOS legs of a fromJSON list": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix(`        os: \${{ fromJSON(github.event_name == 'pull_request' && '["ubuntu-24.04"]' || '["ubuntu-24.04","macos-15"]') }}\n`), steps: plain })] }),
    "a self-hosted Linux runner": tWorkflow({ jobs: [tJob({ runsOn: "[self-hosted, linux, x64]", steps: plain })] }),
    "the workflow's defaults.run.shell bash on windows-2025": tWorkflow({ defaults: "bash", jobs: [tJob({ runsOn: "windows-2025", steps: plain })] }),
    "the job's defaults.run.shell bash on windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", defaults: "bash", steps: plain })] }),
    "the step's shell: bash on windows-2025": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", steps: [tStep({ run: "ls", shell: "bash" })] })] }),
    "the toxiproxy action on Linux": tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/toxiproxy" })] })] }),
    "workflow opt-out 1": tWorkflow({ env: { POWERSHELL_TELEMETRY_OPTOUT: "1" }, jobs: [tJob({ runsOn: "windows-2025", steps: plain })] }),
    "job opt-out yes": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: "yes" }, steps: plain })] }),
    "step opt-out TRUE": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "Get-ChildItem", shell: "pwsh", env: { POWERSHELL_TELEMETRY_OPTOUT: "TRUE" } })] })] }),
    "the step's opt-out 1 over the job's 0": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: "0" }, steps: [tStep({ run: "node --version", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" } })] })] }),
    "the job's opt-out 1 over the workflow's 0": tWorkflow({ env: { POWERSHELL_TELEMETRY_OPTOUT: "0" }, jobs: [tJob({ runsOn: "windows-2025", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" }, steps: plain })] }),
    // A uses: step's env reaches the steps of the composite action it runs.
    "the toxiproxy action on windows-2025 with the opt-out in its step's env": tWorkflow({ jobs: [tJob({ runsOn: "windows-2025", defaults: "bash", steps: [tStep({ uses: "./.github/actions/toxiproxy", env: { POWERSHELL_TELEMETRY_OPTOUT: "1" } })] })] }),
    // A job's defaults: that sets only working-directory leaves the workflow's defaults.run.shell in force.
    "the workflow's defaults.run.shell bash under a job's defaults that set only working-directory, on windows-2025": tWorkflow({ defaults: "bash", jobs: [tJob({ runsOn: "windows-2025", steps: plain }).replace("    steps:\n", "    defaults:\n      run:\n        working-directory: app\n    steps:\n")] }),
    "the step's shell: bash over the job's defaults.run.shell pwsh": tWorkflow({ jobs: [tJob({ defaults: "pwsh", steps: [tStep({ run: "ls", shell: "bash" })] })] }),
    "a local composite action with bash steps only, on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yml": action("bash") }],
    "a matrix runner read through a nested path, Linux and macOS": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.target.runner }}", strategy: matrix("        target:\n          - runner: ubuntu-24.04\n          - runner: macos-15\n"), steps: plain })] }),
    "a runner group whose labels name Linux": tWorkflow({ jobs: [tJob({ runsOn: "{ group: org-runners, labels: [self-hosted, linux] }", steps: plain })] }),
    // Inspection 6 of B0-U01: a script that names pwsh only in a comment, an echo, a folder and a file name (m3);
    // GitHub's own self-hosted labels, Linux and macOS, in any case (S12); a runs-on whose text names Ubuntu beside an
    // expression (S13); an include entry that adds a key to every leg and names no runner (S15); fromJson, as GitHub
    // reads a function's name in any case (S16); a local action whose only step uses another action (S21).
    "a bash step that only names pwsh": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: '# pwsh -File later.ps1\necho "pwsh is not used here"\n./tools/pwsh/check.sh\nbash pwsh-free.sh' })] })] }),
    "a self-hosted runner labelled Linux, as GitHub labels one": tWorkflow({ jobs: [tJob({ runsOn: "[self-hosted, Linux, X64]", steps: plain })] }),
    "a self-hosted runner labelled macOS": tWorkflow({ jobs: [tJob({ runsOn: "[self-hosted, macOS, ARM64]", steps: plain })] }),
    "a runs-on with an expression after ubuntu-": tWorkflow({ jobs: [tJob({ runsOn: "ubuntu-${{ matrix.v }}", strategy: matrix('        v: ["24.04", "22.04"]\n'), steps: plain })] }),
    "a matrix include entry that names no runner": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix("        os: [ubuntu-24.04, macos-15]\n        include:\n          - experimental: true\n"), steps: plain })] }),
    "a fromJson list": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.os }}", strategy: matrix(`        os: \${{ fromJson('["ubuntu-24.04","macos-15"]') }}\n`), steps: plain })] }),
    "a local composite action whose only step uses another action, on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yml": `name: Tool\ndescription: Runs a tool.\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@${SHA}\n` }],
    "a local composite action whose bash step names pwsh only in a comment, on windows-2025": [onWindows("./.github/actions/tool"), { ".github/actions/tool/action.yml": action("bash").replace("run: ls", "run: |\n        # pwsh -File tool.ps1 is the Windows path\n        ls") }],
    // Inspection 7 of B0-U01 (n2, n3): the standard-user action on Linux, whose pwsh step is its Windows step, as the
    // toxiproxy action's is; a local action with bash steps only, on Linux; pwsh in quotes as an argument, also after a
    // flag that ends in c; pwsh's install folder and a folder named pwsh; a Linux label beside an expression label.
    "the standard-user action on Linux": tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/standard-user" })] })] }),
    "a local composite action with bash steps only, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/tool" })] })] }), { ".github/actions/tool/action.yml": action("bash") }],
    "a bash step that names pwsh in quotes, as an argument": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'grep -q "pwsh" list.txt\ngrep -c \'pwsh\' list.txt\n[ "$SHELL" = "pwsh" ]\ngit commit -m "/usr/bin/pwsh is the path"' })] })] }),
    "a bash step that names pwsh's install folder or a folder named pwsh": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: 'ls /opt/microsoft/powershell/7/\ncp build.ps1 /tmp/pwsh-scripts/\nexport PATH="$PATH:/opt/microsoft/powershell/7"' })] })] }),
    "a self-hosted list with a Linux label beside an expression label": tWorkflow({ jobs: [tJob({ runsOn: '[self-hosted, linux, "${{ vars.SIZE }}"]', steps: plain })] }),
    // Inspection 8 of B0-U01 (p1 to p3): a path to pwsh after = is an assignment or an option's value, not a start; an
    // include entry with a Linux label beside an expression label; local actions that use local actions with bash steps
    // only: one, one that uses itself, and a chain of ten, as deep as the check follows; one that uses the toxiproxy
    // action, on Linux.
    "a path to pwsh after =": tWorkflow({ jobs: [tJob({ steps: [tStep({ run: "PWSH=/usr/bin/pwsh\ndotnet tool run lint --shell=/usr/bin/pwsh" })] })] }),
    "an include entry with a Linux label beside an expression label": tWorkflow({ jobs: [tJob({ runsOn: "${{ matrix.runner }}", strategy: matrix('        include:\n          - runner: [self-hosted, linux, "${{ vars.SIZE }}"]\n'), steps: plain })] }),
    "a local action that uses a local action with bash steps only, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/outer" })] })] }), { ".github/actions/outer/action.yml": nest("./.github/actions/tool"), ".github/actions/tool/action.yml": action("bash") }],
    "a local action that uses itself": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/outer" })] })] }), { ".github/actions/outer/action.yml": nest("./.github/actions/outer") }],
    "a chain of ten local actions with bash steps only": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/a1" })] })] }), chain(10)],
    "a local action that uses the toxiproxy action, on Linux": [tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/outer" })] })] }), { ".github/actions/outer/action.yml": nest("./.github/actions/toxiproxy") }],
  };
  for (const [why, v] of Object.entries(passes)) {
    const r = tele(...withFiles(v));
    assert.equal(r.code, 0, `${why}: ${r.out}`);
  }
  // A long run of options after bash is read in linear time: an option's argument is never another option, so the run
  // splits one way only (B0-U01 round 8; without that rule the ways to split it double about every option and a half).
  // Timed in this process on the parsed workflow, so that a child process's start (a second or more under Electron's
  // Node) is not in the time.
  const { parseYaml: read, telemetryProblems } = await import("../check-hygiene.mjs");
  const opts = Array.from({ length: 38 }, (_, i) => `-${String.fromCharCode(97 + (i % 26))}x`).join(" ");
  const long = read(tWorkflow({ jobs: [tJob({ steps: [tStep({ run: `bash ${opts} build.sh` })] })] }));
  const start = performance.now();
  const found = telemetryProblems(".github/workflows/ci.yml", long);
  const ms = Math.round(performance.now() - start);
  assert.deepEqual(found, []);
  assert.ok(ms < 1000, `a run of 38 options after bash took ${ms} ms`);
});

test("telemetry (4): a composite action's step that runs gh, pnpm or turbo needs the opt-out in its own env (PG-D14; B0-U01)", () => {
  const action = (env) =>
    `name: Notes\ndescription: Reads the release.\nruns:\n  using: composite\n  steps:\n    - name: Read\n      shell: bash\n${env ? `      env:\n${Object.entries(env).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}\n`).join("")}` : ""}      run: |\n        gh release view "$TAG"\n        pnpm --filter app build\n`;
  const ok = tWorkflow({ jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/notes" })] })] });
  const bare = tele(ok, { ".github/actions/notes/action.yml": action() });
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.out, /notes\/action\.yml:\d+: a step that runs gh \(runs\.steps\) has no telemetry opt-out/);
  assert.match(bare.out, /notes\/action\.yml:\d+: a step that runs pnpm or turbo \(runs\.steps\)/);
  // The workflow's env does not count for the action: the rule reads the action's own step env.
  const callerOnly = tele(tWorkflow({ env: { GH_TELEMETRY: "0", DO_NOT_TRACK: "1" }, jobs: [tJob({ steps: [tStep({ uses: "./.github/actions/notes" })] })] }), { ".github/actions/notes/action.yml": action() });
  assert.equal(callerOnly.code, 1, callerOnly.out);
  const set = tele(ok, { ".github/actions/notes/action.yml": action({ GH_TELEMETRY: "0", DO_NOT_TRACK: "1" }) });
  assert.equal(set.code, 0, set.out);
  // The same action in action.yaml is read too (inspection 4 of B0-U01: N4).
  const yaml = tele(ok, { ".github/actions/notes/action.yaml": action() });
  assert.equal(yaml.code, 1, yaml.out);
  assert.match(yaml.out, new RegExp(`notes/action\\.yaml:${action().split("\n").indexOf("    - name: Read") + 1}: a step that runs gh \\(runs\\.steps\\)`));
  // Any step of the action: its gh step is the second, after a step that runs none, and is named at its own line.
  const second = `name: Notes\ndescription: Reads the release.\nruns:\n  using: composite\n  steps:\n    - name: Prepare\n      shell: bash\n      run: echo start\n    - name: Read\n      shell: bash\n      run: gh release view "$TAG"\n`;
  const two = tele(ok, { ".github/actions/notes/action.yml": second });
  assert.equal(two.code, 1, two.out);
  assert.match(two.out, new RegExp(`notes/action\\.yml:${second.split("\n").indexOf("    - name: Read") + 1}: a step that runs gh \\(runs\\.steps\\)`));
  // ... and the first of two, before a step that runs none.
  const first = `name: Notes\ndescription: Reads the release.\nruns:\n  using: composite\n  steps:\n    - name: Read\n      shell: bash\n      run: gh release view "$TAG"\n    - name: Report\n      shell: bash\n      run: echo done\n`;
  const one = tele(ok, { ".github/actions/notes/action.yml": first });
  assert.equal(one.code, 1, one.out);
  assert.match(one.out, new RegExp(`notes/action\\.yml:${first.split("\n").indexOf("    - name: Read") + 1}: a step that runs gh \\(runs\\.steps\\)`));
  // An action.yml under .github/actions that the reader cannot read is reported, so its opt-outs never pass unread.
  const unread = tele(ok, { ".github/actions/broken/action.yml": "base: &b\n  using: composite\nruns:\n  <<: *b\n  steps: []\n" });
  assert.equal(unread.code, 1, unread.out);
  assert.match(unread.out, /\.github\/actions\/broken\/action\.yml: could not be read as YAML \(.+\), so its telemetry opt-outs were not checked/);
});

// Telemetry (5)'s fixtures (B0-U01, round 4): each is one of the template's own files, cut down, and this is the file
// under .github/ that each is cut from. The test after telemetry (5) compares them.
const CUT_FROM = {
  "nightly.yml": "workflows/nightly.yml",
  "codeql.yml": "workflows/codeql.yml",
  "ci-electron.yml": "workflows/ci-electron.yml",
  "ci-rust.yml": "workflows/ci-rust.yml",
  "release.yml": "workflows/release.yml",
  "ci-dotnet.yml": "workflows/ci-dotnet.yml",
  "toxiproxy-action.yml": "actions/toxiproxy/action.yml",
};
// The jobs each fixture keeps. The comparison allows a job left out whole, so without this list a job could be cut
// that no assertion names: nightly.yml's ci, the one job with no steps: (it calls ci-*.yml), has no finding to pin it
// (B0-U01, inspection 5: F7).
const KEPT_JOBS = {
  "nightly.yml": ["visibility", "ci", "mutation-dotnet", "mutation-js", "report"],
  "codeql.yml": ["visibility", "analyze"],
  "ci-electron.yml": ["verify", "e2e"],
  "ci-rust.yml": ["lint", "test", "ui-gates"],
  "release.yml": ["verify-tag", "publish"],
  "ci-dotnet.yml": ["test"],
  "toxiproxy-action.yml": [],
};
// The ids of the jobs a workflow's text holds, in order: the keys indented two spaces under its top-level jobs:, as
// cutDifference reads them.
const jobIds = (text) => {
  const ids = [];
  let inJobs = false;
  for (const l of text.split("\n")) {
    if (/^[^\s#]/.test(l)) inJobs = /^jobs:/.test(l);
    else if (inJobs && /^ {2}[^\s#]/.test(l)) ids.push(l.trim().replace(/:.*$/, ""));
  }
  return ids;
};
const TELEMETRY_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "telemetry");
const fixture = (name) => readFileSync(join(TELEMETRY_FIXTURES, name), "utf8");
// The text without each of the given whole lines, each of which it holds exactly once; and the text with lines added
// after a line it holds exactly once.
const without = (text, ...gone) =>
  gone.reduce((t, l) => {
    const parts = t.split(`\n${l}\n`);
    assert.equal(parts.length, 2, `${JSON.stringify(l)} is not a line of the text exactly once`);
    return parts.join("\n");
  }, text);
const after = (text, line, ...added) => {
  const parts = text.split(`\n${line}\n`);
  assert.equal(parts.length, 2, `${JSON.stringify(line)} is not a line of the text exactly once`);
  return parts.join(`\n${[line, ...added].join("\n")}\n`);
};
// Whether a copy is its source file cut down, judged by the text alone, not by the reader under test: the source
// without its header comment (the comment and blank lines before its first key) and without whole jobs, its
// placeholders filled and every other line as it is. Every top-level block is kept whole; a job is kept line for line
// from its key line up to the next job's key line, or left out whole. The copy's own header comment is not compared.
// The first difference, or "" when there is none.
function cutDifference(source, copy) {
  const lines = (text) => text.replace(/\n$/, "").split("\n");
  const first = (ls) => ls.findIndex((l) => !/^\s*(#.*)?$/.test(l));
  const src = lines(source);
  const cp = lines(copy);
  const blocks = [];
  let inJobs = false;
  for (let i = first(src); i >= 0 && i < src.length; i++) {
    if (/^[^\s#]/.test(src[i])) {
      inJobs = /^jobs:/.test(src[i]);
      blocks.push({ job: false, from: i });
    } else if (inJobs && /^ {2}[^\s#]/.test(src[i])) blocks.push({ job: true, from: i });
  }
  blocks.forEach((b, k) => (b.to = blocks[k + 1]?.from ?? src.length));
  // A source line with a placeholder matches the copy's line with any text in its place.
  const hole = new RegExp(`\\{\\{${"tpl:"}[A-Z][A-Z0-9_]*\\}\\}`);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const same = (s, c) => s === c || (c !== undefined && hole.test(s) && new RegExp(`^${s.split(hole).map(esc).join(".+")}$`).test(c));
  let p = first(cp);
  if (p < 0 || !blocks.length) return "no key in the copy or the source";
  for (const b of blocks) {
    if (b.job && cp[p] !== src[b.from]) continue; // a job left out whole
    for (let i = b.from; i < b.to; i++, p++) {
      if (!same(src[i], cp[p])) return `line ${p + 1} reads ${JSON.stringify(cp[p] ?? "(the end of the file)")} where line ${i + 1} of the source reads ${JSON.stringify(src[i])}`;
    }
  }
  return p < cp.length ? `line ${p + 1} reads ${JSON.stringify(cp[p])}, which the source does not hold there` : "";
}

// The shapes of the template's own workflows and actions (B0-U01's closing inspection asked for them; its inspection 4
// found shapes round 3's copies had left out): a job that calls a reusable workflow and so has no steps, workflows that
// can be called themselves (on: workflow_call, as every ci-*.yml), jobs with needs: and if:, steps with if:, a matrix
// include whose windows-2025 entry is not the first, steps shared through YAML anchors, job env blocks under a workflow
// env, a gh script that starts with comment lines, gh named in a printf message, and a local action whose pwsh step is
// neither its first nor its last. The texts are the fixtures under fixtures/telemetry/: each a template file with its
// header comment and whole jobs left out, compared with the template by the test after this one. Each passes with the
// template's own opt-outs; each case then removes or moves one and pins every finding as a job and a line.
test("telemetry (5): the rules on the template's own workflow shapes (nightly.yml, codeql.yml, ci-electron.yml, ci-rust.yml, release.yml, ci-dotnet.yml and the toxiproxy action; PG-D14; B0-U01)", () => {
  // The line of the first line that holds the last needle, after the lines that hold the needles before it.
  const at = (text, ...needles) => {
    const lines = text.split("\n");
    let i = -1;
    for (const n of needles) {
      i = lines.findIndex((l, j) => j > i && l.includes(n));
      assert.ok(i >= 0, `no line with ${n}`);
    }
    return i + 1;
  };

  // nightly.yml: the visibility job; the ci job, which calls the stack's CI as a reusable workflow and has no steps; a
  // Windows mutation job on bash that starts the toxiproxy action; a JS mutation job with needs: and an env block of its
  // own, whose two run: steps run pnpm; and the report job (if:, needs:), whose bash script runs gh after two comment
  // lines.
  const nightly = fixture("nightly.yml");
  const night = tele(nightly);
  assert.equal(night.code, 0, night.out);
  // Without its gh, pnpm and pwsh opt-outs, every job after the ci job is still read, the jobs with needs: too, and
  // both pnpm steps of one job are named.
  const bareNight = without(nightly, '  GH_TELEMETRY: "0"', '  POWERSHELL_TELEMETRY_OPTOUT: "1"', '  DO_NOT_TRACK: "1"');
  const nb = tele(bareNight);
  assert.equal(nb.code, 1, nb.out);
  assert.deepEqual(named(nb.out, "gh"), [`report:${at(bareNight, "  report:", "- shell: bash")}`, `visibility:${at(bareNight, "- id: v")}`].sort(), nb.out);
  assert.deepEqual(named(nb.out, "pnpm or turbo"), [`mutation-js:${at(bareNight, "  mutation-js:", "- run: pnpm install")}`, `mutation-js:${at(bareNight, "  mutation-js:", "- shell: bash")}`].sort(), nb.out);
  assert.deepEqual(named(nb.out, "pwsh"), [`mutation-dotnet:${at(bareNight, "- uses: ./.github/actions/toxiproxy")}`], nb.out);

  // codeql.yml, whole: the visibility job sets GH_TELEMETRY in its gh step's own env; the analyze job (needs:, if:) has
  // a matrix include whose windows-2025 entry is the second, its one run: step has an if:, and its own env sets the
  // pwsh opt-out.
  const codeql = fixture("codeql.yml");
  const analyzed = tele(codeql);
  assert.equal(analyzed.code, 0, analyzed.out);
  const bareCodeql = without(codeql, '      POWERSHELL_TELEMETRY_OPTOUT: "1"');
  const cb = tele(bareCodeql);
  assert.equal(cb.code, 1, cb.out);
  assert.deepEqual(named(cb.out, "pwsh"), [`analyze:${at(bareCodeql, "- if: matrix.build-mode == 'manual'")}`], cb.out);
  assert.deepEqual(named(cb.out, "gh"), [], cb.out);
  const bareStep = without(codeql, '          GH_TELEMETRY: "0"');
  const cs = tele(bareStep);
  assert.equal(cs.code, 1, cs.out);
  assert.deepEqual(named(cs.out, "gh"), [`visibility:${at(bareStep, "- id: v")}`], cs.out);
  assert.deepEqual(named(cs.out, "pwsh"), [], cs.out);

  // ci-electron.yml: on: workflow_call, as every ci-*.yml (nightly.yml's ci job calls it); the workflow env sets the
  // opt-outs; the verify job has an env block of its own and starts the toxiproxy action on Linux; the e2e job's matrix
  // is a fromJSON with windows-2025 first, and its last two pnpm steps have an if:.
  const electron = fixture("ci-electron.yml");
  const verified = tele(electron);
  assert.equal(verified.code, 0, verified.out);
  const bareJs = without(electron, '  DO_NOT_TRACK: "1"', '  TURBO_TELEMETRY_DISABLED: "1"');
  const ej = tele(bareJs);
  assert.equal(ej.code, 1, ej.out);
  assert.deepEqual(
    named(ej.out, "pnpm or turbo"),
    [
      `verify:${at(bareJs, "  verify:", "- run: pnpm install")}`,
      `verify:${at(bareJs, "- run: pnpm typecheck")}`,
      `verify:${at(bareJs, "- run: pnpm lint")}`,
      `verify:${at(bareJs, "- run: pnpm exec knip")}`,
      `verify:${at(bareJs, "- run: pnpm test")}`,
      `verify:${at(bareJs, "  verify:", "- run: pnpm build")}`,
      `e2e:${at(bareJs, "  e2e:", "- run: pnpm install")}`,
      `e2e:${at(bareJs, "  e2e:", "- run: pnpm build")}`,
      `e2e:${at(bareJs, "- if: runner.os == 'Linux'")}`,
      `e2e:${at(bareJs, "- if: runner.os != 'Linux'")}`,
    ].sort(),
    ej.out,
  );
  assert.deepEqual(named(ej.out, "pwsh"), [], ej.out);
  const barePwsh = without(electron, '  POWERSHELL_TELEMETRY_OPTOUT: "1"');
  const ep = tele(barePwsh);
  assert.equal(ep.code, 1, ep.out);
  assert.deepEqual(named(ep.out, "pwsh"), [`e2e:${at(barePwsh, "  e2e:", "- run: pnpm install")}`], ep.out);

  // ci-rust.yml: on: workflow_call; bash by default; the Windows jobs share their toolchain steps through YAML anchors
  // (&rust-gnullvm on a run: step and &llvm-mingw on a shell: pwsh step, both in lint; &no-baseline in test); the test
  // and ui-gates jobs have env blocks of their own.
  const rust = fixture("ci-rust.yml");
  const built = tele(rust);
  assert.equal(built.code, 0, built.out);
  const bareRust = without(rust, '  POWERSHELL_TELEMETRY_OPTOUT: "1"');
  const rb = tele(bareRust);
  assert.equal(rb.code, 1, rb.out);
  assert.deepEqual(named(rb.out, "pwsh"), [`lint:${at(bareRust, "- &llvm-mingw")}`, `test:${at(bareRust, "  test:", "- *llvm-mingw")}`, `ui-gates:${at(bareRust, "  ui-gates:", "- *llvm-mingw")}`].sort(), rb.out);
  // The opt-out moved from the workflow env into the test job's env holds for that job only: lint before it and
  // ui-gates after it are named, each at its llvm-mingw step (the anchor in lint, the alias in ui-gates).
  const movedRust = after(bareRust, '      INSTA_UPDATE: "no" # a missing or different snapshot fails; nothing is written', '      POWERSHELL_TELEMETRY_OPTOUT: "1"');
  const rm = tele(movedRust);
  assert.equal(rm.code, 1, rm.out);
  assert.deepEqual(named(rm.out, "pwsh"), [`lint:${at(movedRust, "- &llvm-mingw")}`, `ui-gates:${at(movedRust, "  ui-gates:", "- *llvm-mingw")}`].sort(), rm.out);

  // release.yml: a gh step in the verify-tag job and three in the publish job (needs:), whose release-notes step names
  // gh only in a printf message.
  const release = fixture("release.yml");
  const released = tele(release);
  assert.equal(released.code, 0, released.out);
  const bareRelease = without(release, '  GH_TELEMETRY: "0"');
  const rb2 = tele(bareRelease);
  assert.equal(rb2.code, 1, rb2.out);
  const publishGh = [`publish:${at(bareRelease, "- name: Create the draft release")}`, `publish:${at(bareRelease, "- name: The draft holds every asset")}`, `publish:${at(bareRelease, "- name: Publish")}`];
  assert.deepEqual(named(rb2.out, "gh"), [`verify-tag:${at(bareRelease, "- name: The tagged commit passed the CI gate")}`, ...publishGh].sort(), rb2.out);
  // GH_TELEMETRY moved from the workflow env into verify-tag's own env holds for that job only: the three gh steps of
  // publish are named.
  const movedRelease = after(bareRelease, "      version: ${{ steps.v.outputs.version }}", "    env:", '      GH_TELEMETRY: "0"');
  const rr = tele(movedRelease);
  assert.equal(rr.code, 1, rr.out);
  assert.deepEqual(
    named(rr.out, "gh"),
    [`publish:${at(movedRelease, "- name: Create the draft release")}`, `publish:${at(movedRelease, "- name: The draft holds every asset")}`, `publish:${at(movedRelease, "- name: Publish")}`].sort(),
    rr.out,
  );

  // ci-dotnet.yml's test job: on: workflow_call; bash by default, on windows-2025; it starts the toxiproxy action, which
  // the check knows by name.
  const dotnet = fixture("ci-dotnet.yml");
  const tested = tele(dotnet);
  assert.equal(tested.code, 0, tested.out);
  const bareDotnet = without(dotnet, '  POWERSHELL_TELEMETRY_OPTOUT: "1"');
  const db = tele(bareDotnet);
  assert.equal(db.code, 1, db.out);
  assert.deepEqual(named(db.out, "pwsh"), [`test:${at(bareDotnet, "- uses: ./.github/actions/toxiproxy")}`], db.out);
  // The same job with the toxiproxy action's file under another name, so that the check must read it: a bash download
  // step, a bash start step for Linux and macOS, a pwsh start step for Windows (the third of four), a bash wait step.
  const renamed = (text) => {
    const parts = text.split("./.github/actions/toxiproxy");
    assert.equal(parts.length, 2, "one use of the toxiproxy action");
    return parts.join("./.github/actions/proxy");
  };
  const withProxy = { ".github/actions/proxy/action.yml": fixture("toxiproxy-action.yml") };
  const proxied = tele(renamed(dotnet), withProxy);
  assert.equal(proxied.code, 0, proxied.out);
  const bareProxied = renamed(bareDotnet);
  const dp = tele(bareProxied, withProxy);
  assert.equal(dp.code, 1, dp.out);
  assert.deepEqual(named(dp.out, "pwsh"), [`test:${at(bareProxied, "- uses: ./.github/actions/proxy")}`], dp.out);
});

// What the comparison below does, given the text of each file a fixture is cut from (null for one that is not there):
// "absent" when none is there (a copy of .github/scripts alone, as the mutation harness makes), "adopted" when none of
// those that are there holds a template placeholder (an adopter fills them all, and its workflows are its own), and
// "compare" otherwise. The test file's own lines do not decide, so an edit of its header (`reuse annotate` adds a
// copyright line) cannot skip the comparison on the template; six of the seven files hold placeholders, so renaming
// one cannot either (B0-U01, inspection 6: m2).
const comparisonPlan = (texts) => {
  const there = texts.filter((x) => x !== null);
  if (!there.length) return "absent";
  const hole = new RegExp(`\\{\\{${"tpl:"}[A-Z][A-Z0-9_]*\\}\\}`);
  return there.some((x) => hole.test(x)) ? "compare" : "adopted";
};
// The fixtures' problems against the files they are cut from, each saying how to fix it: the fixture folder holds
// exactly the fixtures CUT_FROM names (names), each is its file cut down (cutDifference), and each keeps the jobs
// KEPT_JOBS names. read(name) gives a fixture's text, sourceOf(file) a source file's.
function fixtureProblems(names, read, sourceOf) {
  const out = [];
  const held = [...names].sort().join(", ");
  const want = Object.keys(CUT_FROM).sort().join(", ");
  if (held !== want) out.push(`the fixture folder holds ${held}, where CUT_FROM names ${want}: add or remove the fixture, its CUT_FROM and its KEPT_JOBS entries`);
  for (const [name, from] of Object.entries(CUT_FROM)) {
    const d = cutDifference(sourceOf(from), read(name));
    if (d) out.push(`${name} against .github/${from}: ${d}; cut it again from that file (its header comment and whole jobs left out, its placeholders filled, nothing else changed)`);
    const ids = jobIds(read(name)).join(", ");
    const need = KEPT_JOBS[name].join(", ");
    if (ids !== need) out.push(`${name} keeps the jobs ${ids || "(none)"}, where telemetry (5) needs ${need} of .github/${from}: cut it again with them, or change KEPT_JOBS and the cases that use the job`);
  }
  return out;
}

// Inspection 4 of B0-U01 found that round 3's copies had changed lines they kept: the on: blocks without
// workflow_call (so a rule that skipped called workflows passed), a script without its first, comment line, and a
// step that release.yml does not have. Telemetry (5)'s fixtures are therefore checked against the template itself.
test("telemetry (5)'s fixtures are cut from the template's own files: every top-level block and every job they keep is the template's, line for line, with placeholders filled, and each keeps the jobs telemetry (5) needs (B0-U01)", (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = (f) => join(here, "..", "..", f);
  const texts = Object.fromEntries(Object.values(CUT_FROM).map((f) => [f, existsSync(path(f)) ? readFileSync(path(f), "utf8") : null]));
  // The plan's three outcomes, checked before it decides, so that no change to it can skip the comparison unseen.
  const filled = "jobs: {}\n";
  const unfilled = `name: {{${"tpl:"}APP_NAME}}\n`;
  assert.equal(comparisonPlan([null, null]), "absent");
  assert.equal(comparisonPlan([null, filled]), "adopted");
  assert.equal(comparisonPlan([filled, null, unfilled]), "compare");
  const plan = comparisonPlan(Object.values(texts));
  if (plan !== "compare") {
    t.skip(plan === "absent" ? "the template's workflows are not beside this folder" : "an adopted repository: its workflows are its own");
    return;
  }
  // A template that holds some of the files but not all has renamed or removed one: its fixture is then compared with
  // nothing, so that fails (inspection 5: F8).
  const missing = Object.keys(texts).filter((f) => texts[f] === null);
  assert.deepEqual(missing, [], `a file a fixture is cut from is not there: ${missing.map((f) => `.github/${f}`).join(", ")}; cut the fixture again from the file that replaced it, or remove the fixture and its CUT_FROM and KEPT_JOBS entries`);
  const source = (f) => texts[f];
  assert.deepEqual(fixtureProblems(readdirSync(TELEMETRY_FIXTURES), fixture, source), []);
  // The checks find each kind of change round 3 made, a changed line, a top-level block left out, a line added at the
  // end and text added to a filled line (inspection 6: T5, T6) ...
  const nightly = source(CUT_FROM["nightly.yml"]);
  const changed = {
    "workflow_call left out of on:": [CUT_FROM["ci-electron.yml"], without(fixture("ci-electron.yml"), "  workflow_call: # nightly.yml runs the whole CI again"), /workflow_call/],
    "a script without its first, comment line": [CUT_FROM["nightly.yml"], without(fixture("nightly.yml"), "          # A ratchet to raise: a mutation job measured a floor above its threshold."), /A ratchet to raise/],
    "a step the source does not have": [CUT_FROM["release.yml"], after(fixture("release.yml"), "          echo \"Draft created for $GITHUB_REF_NAME.\"", "      - *ci-gate"), /\*ci-gate/],
    "a kept line changed": [CUT_FROM["codeql.yml"], fixture("codeql.yml").replace("    timeout-minutes: 45\n", "    timeout-minutes: 30\n"), /timeout-minutes: 30/],
    "a top-level block left out": [CUT_FROM["ci-rust.yml"], without(fixture("ci-rust.yml"), "defaults:", "  run:", "    shell: bash # Git Bash on windows-2025, so one script works on both runner kinds"), /defaults:/],
    "a placeholder filled with nothing": [CUT_FROM["ci-rust.yml"], fixture("ci-rust.yml").replace('      - run: "cargo xtask ui-gates"\n', '      - run: ""\n'), /UI_GATES/],
    "a line added at the end": [CUT_FROM["release.yml"], `${fixture("release.yml").replace(/\n$/, "")}\n      - run: echo extra\n`, /echo extra/],
    "text added to a filled line": [CUT_FROM["ci-rust.yml"], fixture("ci-rust.yml").replace('      - run: "cargo xtask ui-gates"\n', '      - run: "cargo xtask ui-gates" # extra\n'), /# extra/],
  };
  for (const [why, [from, copy, needle]] of Object.entries(changed)) assert.match(cutDifference(source(from), copy), needle, why);
  // ... and a fixture the folder should not hold, and a fixture with one more job left out whole, which only the list
  // of kept jobs refuses (inspection 6: T9, T1); a file kept whole, its header comment included, passes.
  const names = Object.keys(CUT_FROM);
  const extra = fixtureProblems([...names, "ci-python.yml"], fixture, source);
  assert.equal(extra.length, 1, extra.join("\n"));
  assert.match(extra[0], /^the fixture folder holds .*ci-python\.yml/);
  assert.equal(cutDifference(nightly, nightly), "");
  const kept = fixture("nightly.yml");
  const [a, b] = [kept.indexOf("\n  ci:\n"), kept.indexOf("\n  mutation-dotnet:\n")];
  assert.ok(a > 0 && b > a, "the nightly fixture keeps its ci job before mutation-dotnet");
  const fewer = kept.slice(0, a + 1) + kept.slice(b + 1);
  assert.equal(cutDifference(nightly, fewer), "");
  const lost = fixtureProblems(names, (n) => (n === "nightly.yml" ? fewer : fixture(n)), source);
  assert.equal(lost.length, 1, lost.join("\n"));
  assert.match(lost[0], /^nightly\.yml keeps the jobs visibility, mutation-dotnet, mutation-js, report, where telemetry \(5\) needs visibility, ci, /);
});

// REUSE reads its tags anywhere in a file, so a tag written inside a test's string is read as the file's own licence,
// and `reuse lint` fails in every adopted repository (B0-U01: line 850 in round 5, line 102 in round 6). A tag may stand
// only in a file's leading comment lines. The tags are built at run time here, so this test does not find itself; a
// self-check on planted text shows the scan finds each tag, on the first line after the header too, and none in the
// header (B0-U01, inspection 7's note).
test("no file of the scripts folder holds a REUSE tag after its leading comment lines (B0-U01)", () => {
  const tag = new RegExp(`SPDX-(${["License-Identifier", "FileCopyrightText", "FileContributor", "SnippetBegin"].join("|")})|REUSE-${"IgnoreStart"}`);
  // The line numbers of a text's tags after its leading comment lines.
  const tagged = (text) => {
    const lines = text.split("\n");
    const body = lines.findIndex((l) => !/^\s*(#|\/\/|\/\*|\*|$)/.test(l));
    return lines.flatMap((l, i) => (body >= 0 && i >= body && tag.test(l) ? [i + 1] : []));
  };
  // REUSE's tags, spelled here apart from the scan's own list, so that a list with a misspelt tag fails here.
  const planted = ["SPDX-" + "License-Identifier", "SPDX-" + "FileCopyrightText", "SPDX-" + "FileContributor", "SPDX-" + "SnippetBegin", "REUSE-" + "IgnoreStart"];
  for (const t of planted) {
    assert.deepEqual(tagged(`// ${t}: x\n\nconst a = "${t}: y";\nconst b = 1;\n  const c = \`# ${t}: z\`;\n`), [3, 5], `the self-check finds ${t}`);
    assert.deepEqual(tagged(`#!/usr/bin/env node\n# ${t}: x\n/* ${t}: y\n * ${t}: z\n */\n`), [], `the self-check reads ${t} in a header as the header`);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const all = files(root);
  const found = [];
  const read = [];
  for (const f of all) {
    read.push(f);
    found.push(...tagged(readFileSync(f, "utf8")).map((n) => `${f.slice(root.length + 1)}:${n}`));
  }
  assert.ok(all.length > 20, "the scripts folder was read");
  assert.ok(read.some((f) => f.endsWith(".yml")), "the files that are not scripts, as the fixtures, were read too");
  assert.deepEqual(found, [], "build the tag at run time, as this test does");
});

// The expected values are the yaml package's (2.x, core schema, scalars compared as strings) for the same text,
// compared in B0-U01's scratch harness; the reader matched it on every workflow and action of the template, the
// promo-site kit and the three B0 proof repositories (45 files, 2026-11-25).
test("the YAML reader reads block scalars with chomping, compact sequences, flow collections over lines, quoted and plain scalars, anchors and aliases (in flow collections too), a byte-order mark and CRLF, and refuses what it cannot read (B0-U01)", async () => {
  const { parseYaml, ITEM_LINES } = await import("../check-hygiene.mjs");
  const text = [
    "run: |",
    "  set -e",
    "    indented",
    "",
    "  last",
    "",
    "strip: >-",
    "  one",
    "  two",
    "",
    "  three",
    "keep: |+",
    "  k",
    "",
    "steps:",
    "- name: a",
    '  env: { K: "1", L: [x, y] }',
    "- &s",
    "  run: gh api",
    "- *s",
    'q: "a\\tb \\"c\\" d',
    '  e"',
    "s: 'it''s'",
    "p: one",
    "  two # c",
    "n:",
    "m: [",
    "  a, # c",
    "  b ]",
    "al: &v x",
    "fl: { k: *v, l: [*v] }",
    "",
  ].join("\n");
  const doc = parseYaml(text);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), {
    run: "set -e\n  indented\n\nlast\n",
    strip: "one two\nthree",
    keep: "k\n\n",
    steps: [{ name: "a", env: { K: "1", L: ["x", "y"] } }, { run: "gh api" }, { run: "gh api" }],
    q: 'a\tb "c" d e',
    s: "it's",
    p: "one two",
    n: null,
    m: ["a", "b"],
    al: "x",
    fl: { k: "x", l: ["x"] },
  });
  assert.deepEqual(doc.steps[ITEM_LINES], [16, 18, 20]);
  // The file's final line break ends the last line; it does not add an empty one to a kept block scalar.
  assert.deepEqual(JSON.parse(JSON.stringify(parseYaml("a: >+\n  p\n\n"))), { a: "p\n\n" });
  // A byte-order mark is not text, so a comment after it is a comment; CRLF line breaks read as LF (B0-U01, inspection
  // 6: S17, S18; the yaml package gives the same values).
  assert.deepEqual(JSON.parse(JSON.stringify(parseYaml("﻿# a comment\na: 1\n"))), { a: "1" });
  assert.deepEqual(JSON.parse(JSON.stringify(parseYaml("run: |\r\n  a\r\n  b\r\nk: v\r\n"))), { run: "a\nb\n", k: "v" });
  for (const bad of ["a: 1\na: 2\n", "a: !!str 1\n", "a: 1\n---\nb: 2\n", "a:\n\tb: 1\n", "s:\n  - &a k: v\n", "? a\n: b\n"]) {
    assert.throws(() => parseYaml(bad), /^Error: line \d+: /, JSON.stringify(bad));
  }
});

test("a workflow the check cannot read as YAML fails closed (B0-U01)", () => {
  const cases = {
    "an alias with no anchor": "name: T\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - *missing\n",
    "a merge key": "name: T\non: [pull_request]\npermissions:\n  contents: read\nbase: &b\n  runs-on: ubuntu-24.04\njobs:\n  a:\n    <<: *b\n    steps:\n      - run: gh pr view 1\n",
    "an unclosed flow sequence": "name: T\non: [pull_request\npermissions:\n  contents: read\njobs: {}\n",
  };
  for (const [why, text] of Object.entries(cases)) {
    const r = tele(text);
    assert.equal(r.code, 1, `${why}: ${r.out}`);
    assert.match(r.out, /ci\.yml: could not be read as YAML \(.+\), so its telemetry opt-outs were not checked/, why);
  }
});
