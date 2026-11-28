#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Commit policy for a pull request: every commit in base..head
//   1. has a Conventional Commits 1.0.0 header (https://www.conventionalcommits.org/en/v1.0.0/)
//      with one of the types below and at most 100 characters,
//   2. carries no Co-Authored-By trailer and no "Generated with" footer line,
//   3. with --identity strict, is authored and committed by an allowed identity,
//   4. with --require-signoff, carries a Signed-off-by line matching its author (DCO).
//
// The repository merges pull requests with merge commits, so every commit on the
// branch lands on main as written: the policy applies to each commit, not only to
// the pull request title. A merge commit made by git (two or more parents) is not
// judged on its subject, only on its identity.
//
// Usage: node check-commits.mjs --base <sha> --head <sha> [--identity strict|off]
//        [--require-signoff] [--allow <email>]... [--title "<pull request title>"]

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const HEADER = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`);
const MAX_HEADER = 100;

// The owner's identity (brief, 2026-11-06), the owner's GitHub noreply address
// (web edits and merges), and the bots the repository runs.
const DEFAULT_ALLOWED = [
  "stojiljkovic.d.luka@gmail.com",
  "101596990+lukastojiljkovic@users.noreply.github.com",
  "49699333+dependabot[bot]@users.noreply.github.com",
  "41898282+github-actions[bot]@users.noreply.github.com",
];
// GitHub itself commits merges made in the web interface.
const WEB_FLOW_COMMITTER = "noreply@github.com";
const BOT = /\[bot\]@users\.noreply\.github\.com$/;

const FORBIDDEN_LINES = [
  { re: /^\s*co-authored-by\s*:/im, why: "carries a Co-Authored-By trailer" },
  { re: /^\W*generated with\b/im, why: 'carries a "Generated with" footer' },
];

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    identity: { type: "string", default: "off" },
    "require-signoff": { type: "boolean", default: false },
    allow: { type: "string", multiple: true, default: [] },
    title: { type: "string" },
  },
});

if (!values.base || !values.head) {
  console.error("usage: check-commits.mjs --base <sha> --head <sha> [--identity strict|off] [--require-signoff]");
  process.exit(2);
}
if (!["strict", "off"].includes(values.identity)) {
  console.error(`--identity must be strict or off, not ${values.identity}`);
  process.exit(2);
}

const allowed = new Set([...DEFAULT_ALLOWED, ...values.allow].map((e) => e.toLowerCase()));

// Unit separator between fields, record separator between commits.
const raw = execFileSync(
  "git",
  ["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", `${values.base}..${values.head}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const commits = raw
  .split("\x1e")
  .map((r) => r.replace(/^\s+/, ""))
  .filter(Boolean)
  .map((r) => {
    const [sha, parents, an, ae, cn, ce, body] = r.split("\x1f");
    return { sha, merge: parents.trim().split(/\s+/).length > 1, an, ae, cn, ce, body: body ?? "" };
  });

const problems = [];
// The pull request title becomes the merge commit's description and the release
// notes' line, so it is held to the same header rule as every commit.
if (values.title !== undefined) {
  const t = values.title.trim();
  if (!HEADER.test(t) || t.length > MAX_HEADER) {
    problems.push(`the pull request title "${t}" is not a Conventional Commit header of at most ${MAX_HEADER} characters`);
  }
}
for (const c of commits) {
  const subject = c.body.split("\n")[0].trim();
  const at = `${c.sha.slice(0, 12)} "${subject}"`;

  if (!c.merge) {
    if (!HEADER.test(subject)) {
      problems.push(`${at}: the header is not a Conventional Commit (type(scope)!: description; types: ${TYPES.join(", ")})`);
    }
    if (subject.length > MAX_HEADER) {
      problems.push(`${at}: the header is ${subject.length} characters; the limit is ${MAX_HEADER}`);
    }
  }

  for (const f of FORBIDDEN_LINES) {
    if (f.re.test(c.body)) problems.push(`${at}: ${f.why}, which this repository never accepts (Co-Authored-By / Generated with)`);
  }

  if (values.identity === "strict") {
    if (!allowed.has(c.ae.toLowerCase())) problems.push(`${at}: author ${c.an} <${c.ae}> is not an allowed identity`);
    const ce = c.ce.toLowerCase();
    if (!allowed.has(ce) && ce !== WEB_FLOW_COMMITTER) problems.push(`${at}: committer ${c.cn} <${c.ce}> is not an allowed identity`);
  }

  if (values["require-signoff"] && !c.merge && !BOT.test(c.ae)) {
    const want = `signed-off-by: ${c.an} <${c.ae}>`.toLowerCase();
    const lines = c.body.split("\n").map((l) => l.trim().toLowerCase());
    if (!lines.includes(want)) problems.push(`${at}: no Signed-off-by line for ${c.an} <${c.ae}> (use git commit -s)`);
  }
}

const summary = problems.length
  ? `### Commit policy: ${problems.length} problem(s)\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`
  : `### Commit policy: ${commits.length} commit(s) checked, no problems\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(problems.length ? 1 : 0);
