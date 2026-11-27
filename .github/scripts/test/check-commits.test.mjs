// SPDX-License-Identifier: MIT
// Each case names the break it catches: a policy rule that stops firing makes one fail.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, makeRepo, OWNER, removeTree, run } from "./helpers.mjs";

const STRANGER = { name: "Someone Else", email: "someone@example.com" };
const DEPENDABOT = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

function history(build) {
  const repo = makeRepo();
  repo.write("README.md", "base\n");
  const base = repo.commit("docs: start");
  repo.branch("work");
  build(repo);
  const head = repo.commit("chore: tip");
  return { repo, base, head };
}

function check(h, extra = []) {
  return run("check-commits.mjs", ["--base", h.base, "--head", h.head, ...extra], h.repo.dir);
}

test("accepts conventional commits by the owner", (t) => {
  const h = history((r) => {
    r.write("a.txt", "1");
    r.commit("feat(maps): search every street");
    r.write("a.txt", "2");
    r.commit("fix: keep the catalogue open\n\nThe toggle closed itself on click.");
  });
  t.after(() => h.repo.cleanup());
  const r = check(h, ["--identity", "strict"]);
  assert.equal(r.code, 0, r.out);
});

test("refuses a subject that is not a conventional commit", (t) => {
  const h = history((r) => r.commit("Fixed the thing"));
  t.after(() => h.repo.cleanup());
  const r = check(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Fixed the thing/);
});

test("refuses an unknown type", (t) => {
  const h = history((r) => r.commit("feature: add a thing"));
  t.after(() => h.repo.cleanup());
  assert.equal(check(h).code, 1);
});

test("refuses a header longer than 100 characters", (t) => {
  const h = history((r) => r.commit(`fix: ${"x".repeat(96)}`));
  t.after(() => h.repo.cleanup());
  assert.equal(check(h).code, 1);
});

test("refuses a Co-Authored-By trailer in any letter case", (t) => {
  const h = history((r) => r.commit("fix: a\n\nco-authored-by: Bot <bot@example.com>"));
  t.after(() => h.repo.cleanup());
  const r = check(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Co-Authored-By/i);
});

test("refuses a Generated with footer", (t) => {
  const h = history((r) => r.commit("fix: a\n\n\u{1F916} Generated with [Some Tool](https://example.com)"));
  t.after(() => h.repo.cleanup());
  assert.equal(check(h).code, 1);
});

test("allows the words generated with inside a sentence", (t) => {
  const h = history((r) => r.commit("build: add an SBOM\n\nThe SBOM is generated with syft."));
  t.after(() => h.repo.cleanup());
  const r = check(h);
  assert.equal(r.code, 0, r.out);
});

test("strict identity refuses a commit by another author", (t) => {
  const h = history((r) => r.commit("fix: a", STRANGER));
  t.after(() => h.repo.cleanup());
  const r = check(h, ["--identity", "strict"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /someone@example\.com/);
});

test("strict identity refuses a foreign committer under the owner's authorship", (t) => {
  const h = history((r) => r.commit("fix: a", OWNER, STRANGER));
  t.after(() => h.repo.cleanup());
  assert.equal(check(h, ["--identity", "strict"]).code, 1);
});

test("strict identity accepts Dependabot", (t) => {
  const h = history((r) => r.commit("build(deps): bump a from 1 to 2", DEPENDABOT));
  t.after(() => h.repo.cleanup());
  // The tip commit is the owner's; Dependabot's must not be refused.
  const r = check(h, ["--identity", "strict"]);
  assert.equal(r.code, 0, r.out);
});

test("identity off accepts an outside contributor", (t) => {
  const h = history((r) => r.commit("fix: a", STRANGER));
  t.after(() => h.repo.cleanup());
  assert.equal(check(h, ["--identity", "off"]).code, 0);
});

test("sign-off is enforced only when asked, and must match the author", (t) => {
  const h = history((r) => {
    r.commit("fix: a\n\nSigned-off-by: Someone Else <someone@example.com>", STRANGER);
    r.commit("fix: b", STRANGER);
  });
  t.after(() => h.repo.cleanup());
  assert.equal(check(h, ["--identity", "off"]).code, 0);
  const r = check(h, ["--identity", "off", "--require-signoff"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fix: b/);
  assert.doesNotMatch(r.out, /fix: a\b.*sign/i);
});

test("a merge commit made by git is not judged as a conventional subject", (t) => {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  repo.write("a.txt", "1");
  const base = repo.commit("docs: start");
  repo.branch("work");
  repo.write("b.txt", "1");
  repo.commit("feat: b");
  repo.checkout("main");
  repo.write("c.txt", "1");
  repo.commit("fix: c");
  repo.checkout("work");
  // A branch brought up to date with main, as a protected main requires.
  const as = {
    GIT_AUTHOR_NAME: OWNER.name,
    GIT_AUTHOR_EMAIL: OWNER.email,
    GIT_COMMITTER_NAME: OWNER.name,
    GIT_COMMITTER_EMAIL: OWNER.email,
  };
  git(repo.dir, ["merge", "-q", "--no-edit", "main"], as);
  const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
  const r = run("check-commits.mjs", ["--base", base, "--head", head, "--identity", "strict"], repo.dir);
  assert.equal(r.code, 0, r.out);
});

test("a hand-written subject that only starts with Merge is still judged", (t) => {
  const h = history((r) => r.commit("Merged my changes"));
  t.after(() => h.repo.cleanup());
  assert.equal(check(h).code, 1);
});

test("a pull request title is held to the same header rule", (t) => {
  const h = history(() => {});
  t.after(() => h.repo.cleanup());
  assert.equal(check(h, ["--title", "fix(packs): verify the signature first"]).code, 0);
  const r = check(h, ["--title", "Update stuff"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /title/i);
});

// The helper under every case above (B0-U01). Git marks its object files read-only, and Node 24's rmSync on Windows stops
// on a read-only file with EPERM, so a throwaway repository must still be removed (Node 26 passes this without the helper's
// retry; it is Node 24 that makes it fail).
test("a throwaway repository is removed by cleanup(), read-only files and git's own objects included", () => {
  const repo = makeRepo();
  repo.write("sub/locked.txt", "read-only\n");
  repo.commit("docs: start");
  chmodSync(join(repo.dir, "sub", "locked.txt"), 0o444);
  assert.ok(existsSync(repo.dir));
  repo.cleanup();
  assert.equal(existsSync(repo.dir), false, "the temporary repository is still on disk");
  // The same for a plain folder, through the exported helper.
  const dir = mkdtempSync(join(tmpdir(), "removetree-"));
  writeFileSync(join(dir, "locked.txt"), "x");
  chmodSync(join(dir, "locked.txt"), 0o444);
  removeTree(dir);
  assert.equal(existsSync(dir), false, "the plain folder is still on disk");
});
