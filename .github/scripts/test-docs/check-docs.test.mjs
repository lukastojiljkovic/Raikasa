// SPDX-License-Identifier: MIT
// Tests of check-docs.mjs, which pr-policy.yml's docs job runs over its list of public Markdown (engineering standard
// 3.9). micromark comes from that job's docs-tools install, so DOCS_TOOLS must name the folder where `npm ci` ran
// (.github/docs-tools). Without it these tests fail; none of them skips (standard 7.2). This folder is outside the
// rules job's `.github/scripts/test/*.test.mjs`, so only the docs job runs it, by name, so that a missing file fails
// the step (a glob that matches nothing passes with 0 tests): `node --test .github/scripts/test-docs/check-docs.test.mjs`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMarkdown, loadMicromark } from "../check-docs.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-docs.mjs");
let loaded;
function micromark() {
  assert.ok(process.env.DOCS_TOOLS, "DOCS_TOOLS is not set: run `npm ci` in .github/docs-tools and set DOCS_TOOLS to that folder, as the docs job does");
  loaded ??= loadMicromark(resolve(process.env.DOCS_TOOLS));
  return loaded;
}
async function kinds(text) {
  return checkMarkdown(text, await micromark()).problems.map((p) => `${p.line}:${p.column} ${p.kind}`);
}

// Made-up addresses (the .invalid top-level domain never resolves).
const A = "someone@example.invalid";
const B = "other@example.invalid";
const NO = "<!-- vale Vale.Terms = NO -->";
const YES = "<!-- vale Vale.Terms = YES -->";
// The template's contact line: text, then the switch around the autolink alone, all on one line.
const CONTACT = `Write to ${NO}<${A}>${YES} for security reports and for notices from\nrights holders.\n`;
const doc = (...parts) => `# Title\n\n${parts.join("\n")}`;

test("the template's contact line is clean: one autolink, rendered as a link, and the switch closed on its line", async () => {
  const r = checkMarkdown(doc(CONTACT), await micromark());
  assert.deepEqual(r.problems, []);
  assert.equal(r.autolinks, 1);
  assert.equal(r.switches, 1);
  // SECURITY.md's list item has the same shape after its bold label.
  assert.deepEqual(await kinds(doc(`- **Or by email** to ${NO}<${A}>${YES}, the address for security reports.\n`)), []);
});

// A line that begins with `<!--` opens an HTML block (CommonMark start condition 2): the autolink after the comment is
// raw HTML, so the address disappears from the page (inspector 7, I7-1).
test("an autolink after a comment that begins its line is reported, at the address", async () => {
  assert.deepEqual(await kinds(doc(`${NO}<${A}>${YES} for reports.\n`)), ["3:30 lost-link"]);
});

test("the lost autolink is reported where the comment begins a quote line, a list item or the second line of a paragraph", async () => {
  assert.deepEqual(await kinds(doc(`> ${NO}<${A}>${YES} for reports.\n`)), ["3:32 lost-link"]);
  assert.deepEqual(await kinds(doc(`- ${NO}<${A}>${YES} for reports.\n`)), ["3:32 lost-link"]);
  assert.deepEqual(await kinds(doc(`Write to\n${NO}<${A}>${YES} for reports.\n`)), ["4:30 lost-link"]);
});

// A count of mailto: links would let another link stand in for the lost one (inspector 8, I8-3): the check is per
// address and per position.
test("another mailto: link in the same file does not hide a lost autolink", async () => {
  const lost = `${NO}<${A}>${YES} for reports.\n`;
  assert.deepEqual(await kinds(doc(lost, `You can also [write to us](mailto:${B}).\n`)), ["3:30 lost-link"]);
  assert.deepEqual(await kinds(doc(lost, `You can also [write to us][mail].\n\n[mail]: mailto:${B}\n`)), ["3:30 lost-link"]);
  assert.deepEqual(await kinds(doc(lost, `Or [${A}](mailto:${A}).\n`)), ["3:30 lost-link"]);
  assert.deepEqual(await kinds(doc(lost, `<p>Or <a href="mailto:${B}">write to us</a>.</p>\n`)), ["3:30 lost-link"]);
});

test("an autolink inside an HTML block, in a link destination or in an indented code block is reported", async () => {
  assert.deepEqual(await kinds(doc(`<div>\nWrite to <${A}> for help.\n</div>\n`)), ["4:10 lost-link"]);
  assert.deepEqual(await kinds(doc(`Write [to us](<${A}>).\n`)), ["3:15 lost-link"]);
  // Four spaces of indent make the contact paragraph a code block: the address is shown as code (accepted fail-safe:
  // an address meant as code goes in a fenced block).
  assert.deepEqual(await kinds(doc(`    Write to ${NO}<${A}>${YES} for reports.\n`)), ["3:43 lost-link"]);
});

// The legitimate text that the count of r8 reported (inspector 8, I8-3).
test("code, comments, escapes, URL autolinks and mailto: destinations are not e-mail autolinks and pass", async () => {
  assert.deepEqual(await kinds(doc(CONTACT, `Put \`<${A}>\` in the header field.\n`)), []);
  assert.deepEqual(await kinds(doc(CONTACT, "```text", `<${A}>`, "<!-- vale off -->", "```\n")), []);
  assert.deepEqual(await kinds(doc(CONTACT, `<!-- Replace <${A}> with the app's address. -->\n`)), []);
  assert.deepEqual(await kinds(doc(CONTACT, `A note <!-- not <${B}> --> in a paragraph.\n`)), []);
  assert.deepEqual(await kinds(doc(CONTACT, `Shown as text: \\<${A}>.\n`)), []);
  assert.deepEqual(await kinds(doc(CONTACT, "News is at <https://example.invalid/@program>.\n")), []);
  assert.deepEqual(await kinds(doc(CONTACT, `Write to <mailto:${B}> or [to us][m].\n\n[m]: <mailto:${B}>\n`)), []);
});

test("a second plain autolink, CRLF line ends and a byte-order mark keep the positions right", async () => {
  const r = checkMarkdown(doc(CONTACT, `Or write to <${B}> for anything else.\n`), await micromark());
  assert.deepEqual([r.problems, r.autolinks], [[], 2]);
  const crlf = doc(CONTACT, `${NO}<${A}>${YES} for reports.\n`).replace(/\n/g, "\r\n");
  assert.deepEqual(await kinds(crlf), ["6:30 lost-link"]);
  assert.deepEqual(await kinds(`\uFEFF${doc(`${NO}<${A}>${YES} for reports.\n`)}`), ["3:30 lost-link"]);
  assert.deepEqual(await kinds(`\uFEFF${doc(CONTACT)}`), []);
});

// The page is micromark's own rendering of the file: a parse and a page that disagreed would be reported.
test("an autolink that the page does not show as a mailto: link to that address is reported", async () => {
  const mm = await micromark();
  const page = (html) => checkMarkdown(doc(CONTACT), { ...mm, micromark: () => html }).problems.map((p) => `${p.line}:${p.column} ${p.kind}`);
  assert.deepEqual(page("<p>Write to for security reports</p>"), ["3:39 render"]);
  assert.deepEqual(page(`<p><a href="mailto:${B}">${B}</a></p>`), ["3:39 render"]);
  assert.deepEqual(page(`<p><a href="mailto:${A}">write to us</a></p>`), ["3:39 render"]);
  assert.deepEqual(page(`<p><a href="mailto:${A}">${A}</a></p>`), []);
});

// Vale 3.26.0 honours `<!-- vale off -->` (also written `<!--vale off-->` or over three lines) and
// `<!-- vale Name = NO -->` with single spaces; `<!-- vale on -->` does not switch on a rule that `= NO` switched off
// (measured 2026-11-26, B0-U02 r9). A switch left open stays off to the end of the file (inspector 8, I8-4).
test("a rule switched off is switched on again on the same line, by the same rule's = YES", async () => {
  assert.deepEqual(await kinds(doc(`Write to ${NO}someone for reports.\n\nLater text.\n`)), ["3:10 vale-unclosed"]);
  assert.deepEqual(await kinds(doc(`Write to ${NO}someone\nand more ${YES} for reports.\n`)), ["3:10 vale-unclosed"]);
  assert.deepEqual(await kinds(doc(`Write to ${NO}someone<!-- vale on --> for reports.\n`)), ["3:10 vale-unclosed"]);
  assert.deepEqual(await kinds(doc(`Write to ${NO}someone<!-- vale Vale.Terms=YES --> for reports.\n`)), ["3:10 vale-unclosed"]);
  assert.deepEqual(await kinds(doc(`Write to ${NO}a${YES} then ${NO}b for reports.\n`)), ["3:76 vale-unclosed"]);
  assert.deepEqual(await kinds(doc("Style off <!-- vale Vale = NO -->here.\n")), ["3:11 vale-unclosed"]);
  assert.deepEqual(await kinds(doc("Style off <!-- vale Vale = NO -->here<!-- vale Vale = YES -->.\n")), []);
});

test("<!-- vale off --> is refused in every shape Vale honours and in near misses, and a switch shown as code is no switch", async () => {
  assert.deepEqual(await kinds(`<!-- vale off -->\n${doc(CONTACT)}`), ["1:1 vale-off"]);
  assert.deepEqual(await kinds(doc("A table <!--vale off-->follows<!--vale on-->.\n")), ["3:9 vale-off"]);
  assert.deepEqual(await kinds(doc("<!--\nvale off\n-->\n")), ["3:1 vale-off"]);
  assert.deepEqual(await kinds(doc("> <!--\n> vale off\n> -->\n")), ["3:3 vale-off"]);
  assert.deepEqual(await kinds(doc("Shown as code: `<!-- vale off -->`.\n\n    <!-- vale off -->\n")), []);
  // Near misses that Vale 3.26.0 ignores (a capital V, no spaces around `=`, two spaces) are refused all the same,
  // which fails safe.
  const near = doc("Text <!-- Vale off --> and <!-- vale Vale.Terms=NO --> and <!-- vale  off -->.\n");
  assert.deepEqual(await kinds(near), ["3:6 vale-off", "3:28 vale-unclosed", "3:60 vale-off"]);
});

function cli(args, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-docs-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the command exits 0 on clean files, 1 on a problem (named by file, line and column, never by address), 2 without its tools", async () => {
  await micromark();
  const tools = resolve(process.env.DOCS_TOOLS);
  const clean = cli(["--tools", tools, "PRIVACY.md", "README.md"], { "PRIVACY.md": doc(CONTACT), "README.md": "# App\n\nText.\n" });
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /2 files, 1 e-mail autolink, 1 Vale switch, 0 problems/);
  const red = cli(["--tools", tools, "PRIVACY.md"], { "PRIVACY.md": doc(`${NO}<${A}>${YES} for reports.\n`) });
  assert.equal(red.status, 1, red.out);
  assert.match(red.out, /^PRIVACY\.md:3:30: /m);
  assert.doesNotMatch(red.out, /@/, "the output names no address");
  assert.equal(cli(["--tools", join(tools, "no-such-folder"), "README.md"], { "README.md": "# App\n" }).status, 2);
  assert.equal(cli(["README.md"], { "README.md": "# App\n" }).status, 2, "no --tools");
  assert.equal(cli(["--tools", tools]).status, 2, "no file");
  assert.equal(cli(["--tools", tools, "MISSING.md"]).status, 2, "a file that is not there");
});

// A runner's working folder can be a junction or a symlink: then the script, the tools and the files all go through it.
test("the command checks when its path, its tools or its working folder go through a junction or a symlink (inspector 8, N1)", async () => {
  await micromark();
  const dir = mkdtempSync(join(tmpdir(), "check-docs-link-"));
  const link = join(dir, "link");
  try {
    mkdirSync(join(dir, "real"));
    copyFileSync(SCRIPT, join(dir, "real", "check-docs.mjs"));
    writeFileSync(join(dir, "real", "PRIVACY.md"), doc(`${NO}<${A}>${YES} for reports.\n`));
    // A copy of the install, so that nothing outside the temporary folder is ever reached through a link.
    cpSync(join(resolve(process.env.DOCS_TOOLS), "node_modules"), join(dir, "real", "tools", "node_modules"), { recursive: true });
    symlinkSync(join(dir, "real"), link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(typeof (await loadMicromark(join(link, "tools"))).micromark, "function", "micromark through the link");
    // An install whose node_modules has no micromark does not borrow the one in the folder above.
    mkdirSync(join(dir, "real", "tools", "sub", "node_modules"), { recursive: true });
    await assert.rejects(loadMicromark(join(link, "tools", "sub")), /no micromark in /);
    const runs = {
      "the script's absolute path through the link": spawnSync(process.execPath, [join(link, "check-docs.mjs"), "--tools", join(link, "tools"), join(link, "PRIVACY.md")], { cwd: dir, encoding: "utf8" }),
      "a relative path from a working folder in the link": spawnSync(process.execPath, ["check-docs.mjs", "--tools", "tools", "PRIVACY.md"], { cwd: link, encoding: "utf8" }),
      // import.meta.url then keeps the link's path, so the guard must take the real path of both sides
      "the same with --preserve-symlinks-main": spawnSync(process.execPath, ["--preserve-symlinks-main", "check-docs.mjs", "--tools", "tools", "PRIVACY.md"], { cwd: link, encoding: "utf8" }),
    };
    for (const [how, r] of Object.entries(runs)) {
      assert.equal(r.status, 1, `${how}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /PRIVACY\.md:3:30: /, how);
      assert.match(r.stdout, /check-docs: 1 file, 0 e-mail autolinks, 1 Vale switch, 1 problem/, how);
    }
  } finally {
    // The link first, by itself (its target is inside the same temporary folder, so even a delete through it stays there).
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
