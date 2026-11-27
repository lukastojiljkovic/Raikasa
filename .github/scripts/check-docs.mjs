#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Checks of the public Markdown that Vale, markdownlint and lychee do not make, run by pr-policy.yml's docs job over
// its list of files (engineering standard 3.9; B0-U02):
//   - E-mail autolinks. Each `<name@host>` of the source (CommonMark's e-mail autolink; not in a code span, a fenced
//     block or an HTML comment, and not after a backslash) must be an e-mail autolink at the same place in micromark's
//     parse, and micromark must render it as a mailto: link to that address. A line that begins with `<!--` opens an
//     HTML block, so an autolink after the comment is raw HTML and the address is gone from the page (inspector 7).
//     The check is per address and per place, so another mailto: link cannot stand in for a lost one (inspector 8).
//   - Vale switches. Each `<!-- vale Name = NO -->` must be followed on the same line by `<!-- vale Name = YES -->`,
//     and `<!-- vale off -->` is not used, so a switch hides no more than the words it is put around (inspector 8).
//     Vale 3.26.0 does not switch a rule on again for `<!-- vale on -->` (measured 2026-11-26), so only `= YES` closes.
// micromark is markdownlint's CommonMark parser; it comes from the docs job's own install (--tools), and without it
// the command exits 2 rather than passing. A problem is named by file, line and column, never by its address.
//
// Usage: node check-docs.mjs --tools .github/docs-tools <file.md>...
// Exit:  0 no problem, 1 a problem, 2 a usage error (no --tools, no micromark in it, no file, a file not readable).
//
// valeIniProblems(text) and valeConfigShadows(root) need no tools: test/docs-gate.test.mjs runs them on .vale.ini and
// on the root in the rules job.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// CommonMark 0.31.2, 6.5: `<`, an address of the HTML standard's grammar, `>`.
const EMAIL_AUTOLINK =
  /<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/g;

// The keys of the template's .vale.ini. Any other key is refused, written with `=` or `:` (an ini file takes both):
// TokenIgnores (inspectors 6b and 8), BlockIgnores, SkippedScopes and IgnoredScopes (inspector 8) were measured to make
// Vale skip prose, and a key this list does not know might do the same. Keys are compared as written, as Vale reads
// them (a lower-case `tokenignores` is not read; refusing it fails safe).
const TOP_KEYS = new Set(["StylesPath", "MinAlertLevel", "Vocab", "Packages"]);
const RULE_KEY = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Every BasedOnStyles names the template's two styles (others may be added); compared as written, as Vale reads them.
const BASED_ON = ["Vale", "Microsoft"];
const BOM = String.fromCharCode(0xfeff);
const withoutBom = (s) => (s.startsWith(BOM) ? s.slice(1) : s);

export function valeIniProblems(source) {
  const problems = [];
  let section = null;
  source.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim(); // trim() also drops a byte-order mark
    if (!line || line.startsWith("#") || line.startsWith(";")) return;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1];
      return;
    }
    const pair = /^([^=:]+?)\s*[=:]/.exec(line);
    if (!pair) {
      problems.push({ line: i + 1, message: "not a comment, a [section] or a key with `=` or `:`" });
      return;
    }
    const key = pair[1];
    const known = section === null ? TOP_KEYS.has(key) : key === "BasedOnStyles" || RULE_KEY.test(key);
    if (!known) {
      const allowed = section === null ? [...TOP_KEYS].join(", ") : "BasedOnStyles and Style.Rule switches";
      problems.push({ line: i + 1, message: `${key} is not a key the template uses here (${allowed}); a key that hides prose from Vale is refused: switch the rule off around the text instead (<!-- vale Style.Rule = NO --> ... <!-- vale Style.Rule = YES --> on one line)` });
    } else if (key === "BasedOnStyles") {
      // An empty list, in the template's section or in a new one, made Vale report nothing (inspector 8, N3).
      const styles = new Set(line.slice(pair[0].length).split(",").map((s) => s.trim()));
      const missing = BASED_ON.filter((s) => !styles.has(s));
      if (missing.length) problems.push({ line: i + 1, message: `BasedOnStyles must name ${BASED_ON.join(" and ")} in every section (it lacks ${missing.join(" and ")}); a shorter list switches the template's rules off for the files the section matches` });
    }
  });
  return problems;
}

// Vale 3.26.0, run from the root, reads vale.ini, _vale or a .vale file there instead of .vale.ini (measured 2026-11-26;
// _vale.ini did not win, and is refused as well, which fails safe). Names are compared in lower case, as a Windows
// runner finds them; the template's .vale folder (StylesPath) is the one entry of these names that is allowed.
const VALE_CONFIGS = new Set(["vale.ini", "_vale", "_vale.ini", ".vale"]);

export function valeConfigShadows(root) {
  return readdirSync(root)
    .filter((name) => VALE_CONFIGS.has(name.toLowerCase()) && !(name === ".vale" && lstatSync(join(root, name)).isDirectory()))
    .sort();
}

// micromark from the docs-tools install itself (its lockfile puts it at node_modules/micromark), not from a folder
// above it. Node resolves a package to its real path, so the install's folder is compared by its real path too: a
// working folder through a junction or a symlink would otherwise fail every run (inspector 8, N1).
export async function loadMicromark(tools) {
  const own = resolve(tools, "node_modules") + sep;
  let entry;
  let real;
  try {
    real = realpathSync(resolve(tools, "node_modules")) + sep;
    entry = createRequire(join(resolve(tools), "package.json")).resolve("micromark");
  } catch {
    entry = null;
  }
  if (!entry || !entry.startsWith(real)) throw new Error(`no micromark in ${own}: run \`npm ci --ignore-scripts\` in ${tools} first`);
  const mm = await import(pathToFileURL(entry).href);
  for (const name of ["micromark", "parse", "postprocess", "preprocess"]) {
    if (typeof mm[name] !== "function") throw new Error(`${entry} exports no ${name}()`);
  }
  return mm;
}

const within = (ranges, at) => ranges.some(([a, b]) => a <= at && at < b);
const decode = (s) => s.replace(/&(amp|quot|lt|gt);/g, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">" })[e]);

export function checkMarkdown(source, mm) {
  const text = withoutBom(source);
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const at = (offset) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
    return { line: line + 1, column: offset - starts[line] + 1 };
  };

  // micromark's own parse; token offsets are offsets into `text` (a CRLF counts 2, a tab 1).
  const events = mm.postprocess(mm.parse().document().write(mm.preprocess()(text, undefined, true)));
  const code = [];
  const indented = [];
  const escapes = [];
  const html = [];
  const emails = new Set();
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    const range = [token.start.offset, token.end.offset];
    if (token.type === "codeText" || token.type === "codeFenced") code.push(range);
    else if (token.type === "codeIndented") indented.push(range);
    else if (token.type === "characterEscape") escapes.push(range);
    else if (token.type === "htmlFlow" || token.type === "htmlText") html.push(range);
    else if (token.type === "autolinkEmail") emails.add(range.join(":"));
  }
  // The HTML comments, from the raw HTML only (in code, `<!--` is text, for the page and for Vale).
  const comments = [];
  for (const [a, b] of html) {
    for (let i = text.indexOf("<!--", a); i !== -1 && i < b; ) {
      const close = text.indexOf("-->", i + 2);
      const closed = close !== -1 && close + 3 <= b;
      const end = closed ? close + 3 : b;
      // The words of a comment over several lines, without the `>` or indent of a quote or list around them.
      const words = text.slice(i + 4, closed ? close : b).replace(/\r?\n[ \t>]*/g, "\n").trim();
      comments.push({ start: i, end, words });
      i = text.indexOf("<!--", end);
    }
  }

  const problems = [];
  const parsed = new Map();
  for (const m of text.matchAll(EMAIL_AUTOLINK)) {
    const k = m.index;
    const address = m[1];
    if (within(code, k) || within(escapes, k) || comments.some((c) => c.start <= k && k < c.end)) continue;
    if (emails.has(`${k + 1}:${k + 1 + address.length}`)) {
      if (!parsed.has(address)) parsed.set(address, []);
      parsed.get(address).push(k);
      continue;
    }
    const why = within(html, k)
      ? "it is raw HTML here (a line that begins with `<!--` or a tag is an HTML block): put text before the comment on that line"
      : within(indented, k)
        ? "it is in an indented code block (four spaces of indent): remove the indent, or put code in a fenced block"
        : "micromark does not read it as an autolink here (a link destination or title?): write it as <name@host> in running text, or as [text](mailto:name@host)";
    problems.push({ ...at(k), kind: "lost-link", message: `this e-mail autolink is not a link on the page: ${why}` });
  }
  // The rendered page (raw HTML escaped, so an <a> written by hand does not count): one mailto: link per autolink,
  // to the same address, with the address as its text.
  const rendered = new Map();
  for (const m of mm.micromark(text).matchAll(/<a href="mailto:([^"]*)">([^<]*)<\/a>/g)) {
    let href;
    try {
      href = decodeURIComponent(decode(m[1]));
    } catch {
      continue;
    }
    if (href === decode(m[2])) rendered.set(href, (rendered.get(href) ?? 0) + 1);
  }
  let autolinks = 0;
  for (const [address, places] of parsed) {
    autolinks += places.length;
    const n = rendered.get(address) ?? 0;
    if (n < places.length) problems.push({ ...at(places[0]), kind: "render", message: `micromark parsed ${places.length} e-mail autolink(s) of this address but rendered ${n} mailto: link(s) to it` });
  }

  // Vale switches. The match is wider than Vale's (any spacing and case): a near miss that Vale ignores is refused
  // too, which fails safe.
  let switches = 0;
  comments.forEach((c, i) => {
    if (/^vale\s+off$/i.test(c.words)) {
      problems.push({ ...at(c.start), kind: "vale-off", message: "<!-- vale off --> switches every rule off: switch the one rule off around the text instead, and on again on the same line (<!-- vale Style.Rule = NO --> ... <!-- vale Style.Rule = YES -->)" });
      return;
    }
    const rule = /^vale\s+(\S+?)\s*=\s*no$/i.exec(c.words);
    if (!rule) return;
    switches++;
    const line = at(c.end - 1).line;
    const yes = `vale ${rule[1]} = YES`;
    if (!comments.slice(i + 1).some((d) => d.words === yes && at(d.start).line === line)) {
      problems.push({ ...at(c.start), kind: "vale-unclosed", message: `this switch is not followed on the same line by <!-- ${yes} -->, so the rule stays off for the rest of the file` });
    }
  });

  problems.sort((p, q) => p.line - q.line || p.column - q.column);
  return { problems, autolinks, switches };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const fail = (message) => {
    console.error(`check-docs: ${message}\nusage: node check-docs.mjs --tools .github/docs-tools <file.md>...`);
    process.exit(2);
  };
  let args;
  try {
    args = parseArgs({ options: { tools: { type: "string" } }, allowPositionals: true });
  } catch (err) {
    fail(err.message);
  }
  if (!args.values.tools) fail("--tools is required: the folder of the docs job's `npm ci` (.github/docs-tools)");
  if (!args.positionals.length) fail("no file to check");
  let mm;
  try {
    mm = await loadMicromark(args.values.tools);
  } catch (err) {
    fail(err.message);
  }
  let files = 0;
  let autolinks = 0;
  let switches = 0;
  let problems = 0;
  for (const file of args.positionals) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (err) {
      fail(`cannot read ${file}: ${err.code ?? err.message}`);
    }
    const r = checkMarkdown(source, mm);
    files++;
    autolinks += r.autolinks;
    switches += r.switches;
    problems += r.problems.length;
    for (const p of r.problems) console.log(`${file}:${p.line}:${p.column}: ${p.message}`);
  }
  console.log(`check-docs: ${plural(files, "file")}, ${plural(autolinks, "e-mail autolink")}, ${plural(switches, "Vale switch", "Vale switches")}, ${plural(problems, "problem")}`);
  process.exit(problems ? 1 : 0);
}

// Real paths on both sides: Node gives import.meta.url as the module's real path, so a script path or working folder
// through a junction or symlink would not match the path as typed, and the command would exit 0 having checked nothing
// (inspector 8, N1).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) await main();
