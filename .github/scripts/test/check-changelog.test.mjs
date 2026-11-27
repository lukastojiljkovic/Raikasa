// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER, git, makeRepo, run } from "./helpers.mjs";

const BASE_LOG = `# Changelog

All notable changes are listed here. The format follows Keep a Changelog, and versions follow Semantic Versioning.

## [Unreleased]

## [1.0.0] - 2026-10-01

### Added

- The first release.
`;

function pr(changeLog, { title = "fix: keep the catalogue open", labels = "", files = { "src/a.txt": "2\n" }, baseLog = BASE_LOG } = {}) {
  const repo = makeRepo();
  repo.write("CHANGELOG.md", baseLog);
  repo.write("src/a.txt", "1\n");
  const base = repo.commit("docs: start");
  repo.branch("work");
  for (const [path, text] of Object.entries(files)) repo.write(path, text);
  if (changeLog) repo.write("CHANGELOG.md", changeLog);
  const head = repo.commit(title);
  const r = run(
    "check-changelog.mjs",
    ["--base", base, "--head", head, "--title", title, "--labels", labels],
    repo.dir,
  );
  repo.cleanup();
  return r;
}

const WITH_ENTRY = BASE_LOG.replace(
  "## [Unreleased]\n",
  "## [Unreleased]\n\n### Fixed\n\n- The catalogue no longer closes when it is expanded.\n",
);

test("a user-visible fix with an Unreleased entry passes", () => {
  const r = pr(WITH_ENTRY);
  assert.equal(r.code, 0, r.out);
});

test("a user-visible fix without a changelog change fails", () => {
  const r = pr(null);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Unreleased/);
});

test("an Unreleased entry that an earlier pull request wrote does not count", () => {
  // The base already has an entry; this pull request leaves the file untouched.
  const r = pr(null, { baseLog: WITH_ENTRY });
  assert.equal(r.code, 1, r.out);
});

test("an entry added under a released version does not count", () => {
  const wrong = BASE_LOG.replace("- The first release.\n", "- The first release.\n- A late note.\n");
  const r = pr(wrong);
  assert.equal(r.code, 1, r.out);
});

test("a breaking change of any type needs an entry", () => {
  const r = pr(null, { title: "refactor!: drop the old settings file" });
  assert.equal(r.code, 1, r.out);
});

test("documentation-only types need no entry", () => {
  const r = pr(null, { title: "docs: explain the updater", files: { "docs/updater.md": "text\n" } });
  assert.equal(r.code, 0, r.out);
});

test("the skip-changelog label exempts a user-visible type", () => {
  const r = pr(null, { labels: "dependencies,skip-changelog" });
  assert.equal(r.code, 0, r.out);
});

test("an Unreleased category outside Keep a Changelog is refused", () => {
  const odd = BASE_LOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Improvements\n\n- Faster.\n");
  const r = pr(odd);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Improvements/);
});

test("a changelog without an Unreleased heading is refused", () => {
  const none = BASE_LOG.replace("## [Unreleased]\n\n", "");
  const r = pr(none.replace("- The first release.\n", "- The first release.\n- More.\n"));
  assert.equal(r.code, 1, r.out);
});

// The repository merges with merge commits, never squash (AGENTS.md, PG-D24), so every commit of the branch reaches main
// as written: a user-visible commit under a ci: or chore: title is a user-visible change (E7; B0-U12).
function prCommits(commits, { title, labels = "", changeLog = null } = {}) {
  const repo = makeRepo();
  repo.write("CHANGELOG.md", BASE_LOG);
  repo.write("src/a.txt", "1\n");
  const base = repo.commit("docs: start");
  repo.branch("work");
  commits.forEach((message, i) => {
    repo.write(`src/c${i}.txt`, `${i}\n`);
    if (changeLog && i === commits.length - 1) repo.write("CHANGELOG.md", changeLog);
    repo.commit(message);
  });
  const head = repo.commit(title);
  const r = run("check-changelog.mjs", ["--base", base, "--head", head, "--title", title, "--labels", labels], repo.dir);
  repo.cleanup();
  return r;
}

test("a user-visible commit under a title that is not one still needs an entry, because merge commits keep every commit (B0-U12)", () => {
  const feat = prCommits(["feat(export): write the catalogue to CSV"], { title: "ci: tidy the workflow" });
  assert.equal(feat.code, 1, feat.out);
  assert.match(feat.out, /a "feat" change must add an entry under "## \[Unreleased\]".*commit [0-9a-f]{12} "feat\(export\): write the catalogue to CSV"/);
  for (const message of ["fix: keep the catalogue open", "perf: load the catalogue once", 'revert: "feat: the export"', "refactor(core)!: rename the settings file"]) {
    const r = prCommits([message], { title: "chore: tidy" });
    assert.equal(r.code, 1, `${message}: ${r.out}`);
  }
  const footer = prCommits(["refactor: move the settings\n\nBREAKING CHANGE: the settings file moved to the data folder."], { title: "chore: tidy" });
  assert.equal(footer.code, 1, footer.out);
  assert.match(footer.out, /a "refactor!" change must add an entry/);
  const hyphen = prCommits(["refactor: move the settings\n\nBREAKING-CHANGE: the settings file moved."], { title: "chore: tidy" });
  assert.equal(hyphen.code, 1, hyphen.out);
  // The same branches with an entry, or with the label, pass; commits that are not user-visible need nothing.
  assert.equal(prCommits(["feat(export): write the catalogue to CSV"], { title: "ci: tidy the workflow", changeLog: WITH_ENTRY }).code, 0);
  assert.equal(prCommits(["feat(export): write the catalogue to CSV"], { title: "ci: tidy the workflow", labels: "skip-changelog" }).code, 0);
  const quiet = prCommits(["test: cover the export", "docs: explain the export", "refactor: split the writer\n\nThe words BREAKING CHANGE in a sentence are not a footer."], { title: "ci: tidy the workflow" });
  assert.equal(quiet.code, 0, quiet.out);
});

// A merge that git made, main merged into the branch to bring it up to date, carries main's changes, which main's own
// pull requests logged: its message is no change of this pull request, and check-commits.mjs exempts it from the header
// rule too. So the commits read are those git did not make as merges (git log --no-merges).
test("a merge of main into the branch is no change of the pull request, whatever its message (B0-U01)", () => {
  const repo = makeRepo();
  try {
    repo.write("CHANGELOG.md", BASE_LOG);
    repo.write("src/a.txt", "1\n");
    repo.commit("docs: start");
    repo.branch("work");
    repo.write("src/b.txt", "2\n");
    repo.commit("test: cover the export");
    repo.checkout("main");
    repo.write("src/c.txt", "3\n");
    const base = repo.commit("docs: explain the export");
    repo.checkout("work");
    const who = { GIT_AUTHOR_NAME: OWNER.name, GIT_AUTHOR_EMAIL: OWNER.email, GIT_COMMITTER_NAME: OWNER.name, GIT_COMMITTER_EMAIL: OWNER.email };
    git(repo.dir, ["merge", "-q", "--no-ff", "-m", "feat: bring the branch up to date with main", "main"], who);
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    const r = run("check-changelog.mjs", ["--base", base, "--head", head, "--title", "ci: tidy the workflow", "--labels", ""], repo.dir);
    assert.equal(r.code, 0, r.out);
  } finally {
    repo.cleanup();
  }
});

// When git cannot list the commits of base..head (a base the clone does not hold, a mistyped SHA), the gate cannot tell
// whether a commit is user-visible, so it fails rather than pass on the title alone (B0-U01, closing round).
test("a base whose commits git cannot list fails, whatever the title (B0-U01)", () => {
  const repo = makeRepo();
  try {
    repo.write("CHANGELOG.md", BASE_LOG);
    repo.write("src/a.txt", "1\n");
    repo.commit("docs: start");
    repo.branch("work");
    repo.write("src/b.txt", "2\n");
    const head = repo.commit("feat(export): write the catalogue to CSV");
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const r = run("check-changelog.mjs", ["--base", missing, "--head", head, "--title", "ci: tidy", "--labels", ""], repo.dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the commits of \S+ could not be listed/);
  } finally {
    repo.cleanup();
  }
});

test("versions must be in descending order", () => {
  const out = WITH_ENTRY.replace(
    "## [1.0.0] - 2026-10-01",
    "## [0.9.0] - 2026-09-01\n\n### Added\n\n- Beta.\n\n## [1.0.0] - 2026-10-01",
  );
  const r = pr(out);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /order/i);
});
