#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CHANGELOG.md policy (Keep a Changelog 1.1.0, https://keepachangelog.com/en/1.1.0/):
//   - the file has an "## [Unreleased]" section above every released version;
//   - released versions are "## [x.y.z] - YYYY-MM-DD" and descend;
//   - the only categories are Added, Changed, Deprecated, Removed, Fixed, Security;
//   - a pull request with a user-visible type (feat, fix, perf, revert, or any type
//     marked breaking with "!") adds at least one line to the Unreleased section,
//     unless it carries the skip-changelog label. The type is read from the title and
//     from every commit of base..head that git did not make as a merge: the repository
//     merges with merge commits, never squash, so each commit reaches main as written,
//     and a "feat" commit under a "ci:" title is a user-visible change too. A commit is
//     also breaking when its body has a BREAKING CHANGE (or BREAKING-CHANGE) footer.
//
// Usage: node check-changelog.mjs --base <sha> --head <sha> --title "<PR title>"
//        [--labels "a,b"] [--file CHANGELOG.md]

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const VISIBLE = new Set(["feat", "fix", "perf", "revert"]);
const CATEGORIES = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    title: { type: "string", default: "" },
    labels: { type: "string", default: "" },
    file: { type: "string", default: "CHANGELOG.md" },
  },
});

function show(ref) {
  try {
    return execFileSync("git", ["show", `${ref}:${values.file}`], { encoding: "utf8" });
  } catch {
    return null;
  }
}

// Splits the file into "## " sections; returns the Unreleased body and the problems.
function lint(text) {
  const problems = [];
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  const unreleasedAt = sections.findIndex((s) => s.heading === "[Unreleased]");
  if (unreleasedAt === -1) problems.push('there is no "## [Unreleased]" section');
  if (unreleasedAt > 0) problems.push('"## [Unreleased]" must come before every released version');

  const versions = [];
  for (const s of sections) {
    if (s.heading === "[Unreleased]") continue;
    const m = s.heading.match(/^\[(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?\] - (\d{4}-\d{2}-\d{2})$/);
    if (!m) {
      problems.push(`the heading "## ${s.heading}" is not "## [x.y.z] - YYYY-MM-DD"`);
      continue;
    }
    versions.push({ v: [Number(m[1]), Number(m[2]), Number(m[3])], text: s.heading });
  }
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [versions[i - 1].v, versions[i].v];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (cmp <= 0) problems.push(`versions are out of order: "${versions[i - 1].text}" is followed by "${versions[i].text}"`);
  }
  for (const s of sections) {
    for (const line of s.body) {
      const m = line.match(/^### (.+)$/);
      if (m && !CATEGORIES.has(m[1].trim())) {
        problems.push(`"### ${m[1].trim()}" under "## ${s.heading}" is not a Keep a Changelog category (${[...CATEGORIES].join(", ")})`);
      }
    }
  }
  const unreleased = unreleasedAt === -1 ? [] : sections[unreleasedAt].body;
  return { problems, unreleased };
}

const problems = [];
const head = show(values.head);
if (head === null) {
  problems.push(`${values.file} does not exist on the head`);
} else {
  const linted = lint(head);
  problems.push(...linted.problems);

  const labels = values.labels.split(",").map((l) => l.trim()).filter(Boolean);
  const fromTitle = visible(values.title);
  const commits = fromTitle ? [] : visibleCommits();
  const kind = fromTitle ?? commits[0]?.kind;
  const needsEntry = kind !== undefined && !labels.includes("skip-changelog");

  if (needsEntry) {
    const before = new Set(show(values.base) === null ? [] : lint(show(values.base)).unreleased.map((l) => l.trim()));
    const added = linted.unreleased.map((l) => l.trim()).filter((l) => l.startsWith("- ") && !before.has(l));
    if (!added.length) {
      const why = fromTitle ? "" : `: ${commits.map((c) => `commit ${c.sha.slice(0, 12)} "${c.subject}"`).join(", ")} ${commits.length > 1 ? "are" : "is"} user-visible, and a merge commit takes every commit to main as written`;
      problems.push(
        `a "${kind}" change must add an entry under "## [Unreleased]" in ${values.file}, written for the people who use the software (or carry the skip-changelog label)${why}`,
      );
    }
  }
}

// The kind of a user-visible header ("feat", "fix!", ...), or undefined. A body's BREAKING CHANGE footer makes any
// type breaking (Conventional Commits 1.0.0, items 11 to 16).
function visible(header, body = "") {
  const m = header.match(/^(\w+)(\([^)]*\))?(!)?:/);
  const type = m?.[1] ?? "";
  const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
  return VISIBLE.has(type) || breaking ? `${type}${breaking ? "!" : ""}` : undefined;
}

// The user-visible commits of base..head that git did not make as merges, oldest first.
function visibleCommits() {
  let raw;
  try {
    raw = execFileSync("git", ["log", "--no-merges", "--reverse", "--format=%H%x1f%B%x1e", `${values.base}..${values.head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    problems.push(`the commits of ${values.base}..${values.head} could not be listed: ${String(e.stderr ?? e.message).trim()}`);
    return [];
  }
  return raw
    .split("\x1e")
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, message = ""] = r.split("\x1f");
      const [subject, ...rest] = message.split("\n");
      return { sha, subject: subject.trim(), kind: visible(subject.trim(), rest.join("\n")) };
    })
    .filter((c) => c.kind !== undefined);
}

const summary = problems.length
  ? `### Changelog: ${problems.length} problem(s)\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`
  : "### Changelog: no problems\n";
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(problems.length ? 1 : 0);
