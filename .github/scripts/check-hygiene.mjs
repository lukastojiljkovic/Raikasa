#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Repository hygiene, as the program's engineering standard requires it:
//   - every file a professional repository carries exists and is not empty;
//   - no template placeholder (two opening braces, "tpl:", an UPPER_SNAKE name, two closing
//     braces) survives in any text file, this one included, which is why the pattern is not
//     written out here. The tpl: prefix keeps other double-brace syntax (cloze text, run-time
//     release-note templates, GitHub expressions) out of the check;
//   - every action is pinned to a full 40-character commit SHA;
//   - every workflow declares top-level permissions, and none uses pull_request_target;
//   - every step-security/harden-runner step runs with `egress-policy: block` and
//     `disable-telemetry: true`, never in audit mode (whose default uploads the job's events
//     to the vendor's service), and never in a Windows or macOS job: a job whose runs-on is
//     an expression needs `runner.os == 'Linux'` in the step's `if:` (CV-D58, decided for
//     every repository by the engineering standard on PG-D28's referral; PG-D14, AP §1);
//   - every tool a workflow runs that has telemetry runs with its documented opt-out (PG-D14;
//     B0-U02's docNote D18, B0-U01). The env of a step is the workflow's, then the job's, then
//     the step's own; a composite action's step has only its own. A step that runs `gh` needs
//     GH_TELEMETRY set to a falsey value ("", 0, false, no, disabled, off), or, with GH_TELEMETRY
//     unset, DO_NOT_TRACK 1 or true (cli/cli internal/telemetry/telemetry.go). A step that runs
//     pnpm or turbo needs DO_NOT_TRACK or TURBO_TELEMETRY_DISABLED set to exactly 1 or true
//     (turborepo-telemetry config.rs, is_disabled_by_env). A job that runs pwsh needs
//     POWERSHELL_TELEMETRY_OPTOUT 1, true or yes (pwsh Utils.cs, GetEnvironmentVariableAsBool).
//     A job runs pwsh when the effective shell of one of its run: steps is pwsh or powershell:
//     the step's shell:, else the job's defaults.run.shell, else the workflow's, else the
//     runner's default, which is pwsh on Windows and bash elsewhere. That default is checked on
//     every runner the job's runs-on or matrix can produce (lists, include entries and the JSON
//     lists quoted in a fromJSON expression; a runs-on, or a label of its list or group form,
//     and a value the matrix gives, or a label of a list it gives, that holds an expression is
//     read by its text); a runner the check cannot resolve, or whose labels name no Linux or
//     macOS, counts as Windows. A job also runs pwsh when one of its run: scripts starts pwsh or
//     powershell as a command, on any runner: by name, or by a path whose last part is that name
//     (with or without .exe; absolute, ~, $HOME or relative, quoted or not, but not after =), also
//     in quotes after sh -c or bash -c with any options before the -c. It also runs pwsh when it
//     uses a local action with a pwsh step, on any runner, or one that uses such an action:
//     nested local actions are followed ten deep, deeper counts, and an action already on the
//     way is not read again. The toxiproxy and standard-user actions, whose pwsh steps are their
//     Windows steps, count on such a runner.
//     Comment lines and the text of echo and printf are not runs, but a command substitution in
//     that text is. Step if: conditions are not evaluated. A workflow or action the YAML reader
//     below cannot read is reported, so the check fails closed;
//   - the internal/ documentation folder is ignored by git, and nothing in it is tracked.
//
// Profiles: "app" (every product repository, the default) and "profile" (the
// portfolio/CV and GitHub profile repositories, which carry site files only).
//
// Usage: node check-hygiene.mjs [--root .] [--profile app|profile]

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REQUIRED = {
  app: [
    "README.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "SUPPORT.md",
    "PRIVACY.md",
    "TERMS.md",
    "TRADEMARKS.md", // fixed rules for our names and third-party marks (PG-D16, PG-D21)
    ".editorconfig",
    ".gitattributes",
    ".gitignore",
    ".github/dependabot.yml",
    ".github/CODEOWNERS",
    ".github/ISSUE_TEMPLATE/config.yml",
  ],
  profile: ["README.md"],
};

const SKIP_DIRS = new Set([".git", "node_modules", "target", "bin", "obj", "dist", "out", "artifacts", "internal", ".venv", ".gradle", "TestResults", "mutants.out", "StrykerOutput"]);
const TEXT = /\.(md|txt|ya?ml|json|jsonc|toml|ini|cfg|props|targets|csproj|slnx?|cs|xaml|rs|ts|tsx|js|mjs|cjs|py|kt|kts|gradle|html?|css|xml|ps1|psm1|psd1|sh|iss|editorconfig|gitattributes|gitignore)$|(^|[\\/])(LICENSE|NOTICE|CODEOWNERS|Makefile|Dockerfile)$/i;
const PLACEHOLDER = /\{\{tpl:[A-Z][A-Z0-9_]*\}\}/;

// harden-runner wiring (CV-D58's test, made program-wide; engineering standard 3.0 and 4.5). A
// line-based reading of the workflow: the step is the `- ` item that holds the `uses:` line, and
// its job is the nearest two-space key above it, whose four-space `runs-on:` is read.
function hardenRunnerProblems(rel, lines) {
  const out = [];
  const indent = (l) => l.match(/^ */)[0].length;
  const code = (l) => (l.trimStart().startsWith("#") ? "" : l.replace(/\s+#.*$/, ""));
  lines.forEach((l, i) => {
    if (!/^\s*-?\s*uses:\s*["']?step-security\/harden-runner@/.test(l)) return;
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
    const dash = indent(lines[start]);
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === "" || indent(lines[end]) > dash)) end++;
    const step = lines.slice(start, end).map(code).join("\n");
    const at = `${rel}:${i + 1}`;
    const egress = step.match(/^\s*egress-policy:\s*["']?([A-Za-z]+)/m)?.[1];
    if (egress === "audit") out.push(`${at}: harden-runner with egress-policy: audit uploads the job's events to its vendor's service, which is telemetry; use block (CV-D58, PG-D14)`);
    else if (egress !== "block") out.push(`${at}: harden-runner without egress-policy: block runs in audit mode, its default; set block (CV-D58, PG-D14)`);
    if (!/^\s*disable-telemetry:\s*["']?true["']?\s*$/m.test(step)) out.push(`${at}: harden-runner without disable-telemetry: true (CV-D58, PG-D14)`);
    let job = start;
    while (job >= 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[job])) job--;
    let runsOn = "";
    for (let k = job + 1; k < lines.length; k++) {
      const c = code(lines[k]);
      if (c.trim() && indent(c) <= 2) break;
      const m = c.match(/^ {4}runs-on:\s*(.+?)\s*$/);
      if (m) runsOn = m[1];
    }
    const cond = step.match(/^\s*(?:-\s*)?if:\s*(.+)$/m)?.[1] ?? "";
    if (runsOn.includes("${{")) {
      if (!/runner\.os\s*==\s*'Linux'/.test(cond)) out.push(`${at}: harden-runner in a job whose runs-on is ${runsOn}, without runner.os == 'Linux' in the step's if: none runs on Windows or macOS (CV-D58)`);
    } else if (/windows|macos/i.test(runsOn)) {
      out.push(`${at}: harden-runner in a job that runs on ${runsOn}: none runs on Windows or macOS, where its free tier allows audit mode only (CV-D58)`);
    }
  });
  return out;
}

// ---- A YAML reader for workflow and action files ----------------------------------------------------------------
// These scripts take nothing but Node's standard library, so this reads the YAML that workflows and actions are
// written in: block mappings and sequences (a sequence may sit at its key's indent), block scalars (| and >, with
// - or + and an indentation digit), flow collections over one or more lines, single- and double-quoted scalars,
// plain scalars over several lines, comments, anchors (&a) and aliases (*a). Every scalar stays a string, and an
// empty value (or ~ or null) is null. What it does not read (a merge key, a tag, a complex key, an anchor before a
// key, a duplicate key, a second document, a tab in the indentation) throws, and the caller reports the file, so a
// check built on it fails closed. A mapping carries its first line number under LINE, a sequence each item's line
// number under ITEM_LINES.
export const LINE = Symbol("line");
export const ITEM_LINES = Symbol("itemLines");

export function parseYaml(text) {
  const lines = text
    .replace(/^﻿/, "")
    .replace(/\r?\n$/, "") // the final line break ends the last line; it does not start an empty one
    .split(/\r?\n/)
    .map((raw, i) => {
      const indent = raw.match(/^ */)[0].length;
      return { raw, no: i + 1, indent, text: raw.slice(indent).replace(/\s+$/, "") };
    });
  const anchors = new Map();
  const fail = (no, why) => {
    throw new Error(`line ${no}: ${why}`);
  };
  const blank = (l) => l.text === "" || l.text.startsWith("#");
  const next = (i) => {
    while (i < lines.length && blank(lines[i])) i++;
    return i;
  };
  const isItem = (t) => t === "-" || t.startsWith("- ");
  const setKey = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
  const plainValue = (v) => (v === "" || /^(~|null|Null|NULL)$/.test(v) ? null : v);
  const cutComment = (t) => {
    const h = t.search(/(^|\s)#/);
    return (h === -1 ? t : t.slice(0, h)).trim();
  };

  // The index just past a quoted scalar that starts at p, or -1 when it is not closed.
  const quotedEnd = (s, p) => {
    const q = s[p];
    for (let k = p + 1; k < s.length; k++) {
      if (q === '"' && s[k] === "\\") {
        k++;
        continue;
      }
      if (s[k] === q) {
        if (q === "'" && s[k + 1] === "'") {
          k++;
          continue;
        }
        return k + 1;
      }
    }
    return -1;
  };
  const ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: " ", P: " " };
  // A quoted scalar's value: its lines folded (a line break is a space, each empty line a newline, the edges of the
  // inner lines trimmed), then '' or the backslash escapes read.
  const unquote = (q, no) => {
    const quote = q[0];
    const parts = q.slice(1, -1).split("\n");
    let out = parts[0];
    if (parts.length > 1) {
      out = out.replace(/[ \t]+$/, "");
      let empties = 0;
      for (let k = 1; k < parts.length; k++) {
        const last = k === parts.length - 1;
        const p = last ? parts[k].replace(/^[ \t]+/, "") : parts[k].trim();
        if (p === "" && !last) {
          empties++;
          continue;
        }
        if (quote === '"' && !empties && /(^|[^\\])(\\\\)*\\$/.test(out)) out = out.slice(0, -1) + p; // an escaped line break
        else out += empties ? "\n".repeat(empties) + p : ` ${p}`;
        empties = 0;
      }
    }
    if (quote === "'") return out.replaceAll("''", "'");
    return out.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (_, e) => {
      if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
      if (!Object.hasOwn(ESCAPES, e)) fail(no, `the escape \\${e} is not YAML`);
      return ESCAPES[e];
    });
  };
  const alias = (name, no) => {
    if (!anchors.has(name)) fail(no, `the alias *${name} has no anchor above it`);
    return anchors.get(name);
  };

  // [key, rest of the line] when the text starts with a mapping key, else null.
  const splitKey = (t, no) => {
    if (t[0] === '"' || t[0] === "'") {
      const end = quotedEnd(t, 0);
      if (end < 0) return null;
      const m = t.slice(end).match(/^\s*:(\s+|$)/);
      return m ? [unquote(t.slice(0, end), no), t.slice(end + m[0].length)] : null;
    }
    if (/^\?(\s|$)/.test(t)) fail(no, "a complex key (?) is not read here");
    if (/^[[\]{}&*!|>%@`#,]/.test(t) || isItem(t)) return null;
    const colon = /:(\s|$)/.exec(t);
    const hash = t.search(/\s#/);
    if (!colon || (hash !== -1 && hash < colon.index)) return null;
    return [t.slice(0, colon.index).trim(), t.slice(colon.index + 1).trimStart()];
  };

  // Flow collections: the text is gathered over lines until its brackets close, then read.
  const flowClosed = (s) => {
    let depth = 0;
    let quote = null;
    let prev = "[";
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (quote) {
        if (quote === '"' && c === "\\") k++;
        else if (c === quote) {
          if (quote === "'" && s[k + 1] === "'") k++;
          else quote = null;
        }
        continue;
      }
      if ((c === '"' || c === "'") && /[[{,:]/.test(prev)) quote = c;
      else if (c === "#" && (k === 0 || /\s/.test(s[k - 1]))) {
        while (k < s.length && s[k] !== "\n") k++;
        continue;
      } else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      if (!/\s/.test(c)) prev = c;
    }
    return depth <= 0 && !quote;
  };
  const flowText = (first, i) => {
    let s = first;
    let k = i;
    while (!flowClosed(s)) {
      k++;
      if (k >= lines.length) fail(lines[i].no, "a flow collection is not closed");
      s += `\n${lines[k].raw}`;
    }
    return [s, k + 1];
  };
  const parseFlow = (s, no) => {
    let p = 0;
    const ws = () => {
      for (;;) {
        while (p < s.length && /\s/.test(s[p])) p++;
        if (s[p] !== "#") return;
        while (p < s.length && s[p] !== "\n") p++;
      }
    };
    const need = () => {
      if (p >= s.length) fail(no, "a flow collection is not closed");
    };
    const node = () => {
      ws();
      need();
      let anchor;
      if (s[p] === "&") {
        const m = /^&([^\s,[\]{}]+)/.exec(s.slice(p));
        anchor = m[1];
        p += m[0].length;
        ws();
      }
      if (s[p] === "!") fail(no, "a tag is not read here");
      let v;
      if (s[p] === "[") {
        p++;
        v = [];
        for (;;) {
          ws();
          need();
          if (s[p] === "]") break;
          v.push(node());
          ws();
          need();
          if (s[p] === ":") fail(no, "a single-pair mapping in a flow sequence is not read here");
          if (s[p] === ",") p++;
          else if (s[p] !== "]") fail(no, "a flow sequence needs , or ]");
        }
        p++;
      } else if (s[p] === "{") {
        p++;
        v = {};
        for (;;) {
          ws();
          need();
          if (s[p] === "}") break;
          const k = node();
          ws();
          need();
          let val = null;
          if (s[p] === ":") {
            p++;
            ws();
            need();
            val = s[p] === "," || s[p] === "}" ? null : node();
            ws();
            need();
          }
          if (Object.hasOwn(v, String(k))) fail(no, `the key ${k} appears twice`);
          setKey(v, String(k), val);
          if (s[p] === ",") p++;
          else if (s[p] !== "}") fail(no, "a flow mapping needs , or }");
        }
        p++;
      } else if (s[p] === '"' || s[p] === "'") {
        const e = quotedEnd(s, p);
        if (e < 0) fail(no, "a quoted scalar is not closed");
        v = unquote(s.slice(p, e), no);
        p = e;
      } else if (s[p] === "*") {
        const m = /^\*([^\s,[\]{}]+)/.exec(s.slice(p));
        p += m[0].length;
        v = alias(m[1], no);
      } else {
        const start = p;
        while (p < s.length && !/[,[\]{}]/.test(s[p]) && !(s[p] === ":" && /^([\s,[\]{}]|$)/.test(s.slice(p + 1, p + 2))) && !(s[p] === "#" && /\s/.test(s[p - 1]))) p++;
        v = plainValue(s.slice(start, p).replace(/\s*\n\s*/g, " ").trim());
      }
      if (anchor !== undefined) anchors.set(anchor, v);
      return v;
    };
    const v = node();
    ws();
    if (p < s.length) fail(no, "text after a flow collection");
    return v;
  };

  // A block scalar (| or >) whose header is on line i and whose parent node is indented n.
  const blockScalar = (header, n, i) => {
    const m = /^([|>])([1-9]?)([+-]?)([1-9]?)(\s+#.*)?$/.exec(header);
    if (!m || (m[2] && m[4])) fail(lines[i].no, `the block scalar header ${header} is not read here`);
    const digit = Number(m[2] || m[4] || 0);
    const chomp = m[3];
    let ci = digit ? Math.max(n, 0) + digit : 0;
    if (!ci) {
      let j = i + 1;
      while (j < lines.length && lines[j].raw.trim() === "") j++;
      ci = j < lines.length ? lines[j].indent : 0;
      if (ci <= n) return [chomp === "+" ? "\n".repeat(j - i - 1) : "", j < lines.length ? j : lines.length];
    }
    const body = [];
    let k = i + 1;
    while (k < lines.length) {
      const raw = lines[k].raw;
      if (raw.trim() === "") body.push(raw.length > ci ? raw.slice(ci) : "");
      else if (lines[k].indent >= ci) body.push(raw.slice(ci));
      else break;
      k++;
    }
    let end = body.length;
    while (end > 0 && body[end - 1].trim() === "") end--;
    const content = body.slice(0, end);
    const trailing = body.length - end;
    if (!content.length) return [chomp === "+" ? "\n".repeat(trailing) : "", k];
    let out = "";
    if (m[1] === "|") out = content.join("\n");
    else {
      // Folding: a line break between two lines that do not start with a space is a space; empty lines are
      // newlines; a more-indented line keeps its line breaks.
      let prev = null;
      let empties = 0;
      for (const l of content) {
        if (l === "") {
          empties++;
          continue;
        }
        const more = /^[ \t]/.test(l);
        if (prev === null) out += "\n".repeat(empties);
        else if (prev === "normal" && !more) out += empties ? "\n".repeat(empties) : " ";
        else out += "\n".repeat(empties + 1);
        out += l;
        prev = more ? "more" : "normal";
        empties = 0;
      }
    }
    return [out + (chomp === "-" ? "" : chomp === "+" ? "\n".repeat(trailing + 1) : "\n"), k];
  };

  // A plain scalar that starts on line i, under a parent indented n: more-indented lines continue it.
  const plain = (first, n, i) => {
    let v = cutComment(first);
    let last = i;
    if (v === first.trim()) {
      let empties = 0;
      for (let k = i + 1; k < lines.length; k++) {
        const l = lines[k];
        if (l.text === "") {
          empties++;
          continue;
        }
        if (l.text.startsWith("#") || l.indent <= n) break;
        const t = cutComment(l.text);
        v += empties ? "\n".repeat(empties) + t : ` ${t}`;
        empties = 0;
        last = k;
        if (t !== l.text.trim()) break;
      }
    }
    return [plainValue(v), last + 1];
  };

  const quoted = (rest, i) => {
    let s = rest;
    let k = i;
    while (quotedEnd(s, 0) < 0) {
      k++;
      if (k >= lines.length) fail(lines[i].no, "a quoted scalar is not closed");
      s += `\n${lines[k].raw}`;
    }
    const end = quotedEnd(s, 0);
    const after = s.slice(end).trim();
    if (after && !after.startsWith("#")) fail(lines[k].no, "text after a quoted scalar");
    return [unquote(s.slice(0, end), lines[i].no), k + 1];
  };

  // The value that starts with `rest` on line i, under a parent indented n; inSeq when it is a sequence item.
  const value = (rest, n, i, inSeq) => {
    const no = lines[i].no;
    let anchor;
    const a = /^&(\S+)(\s+|$)/.exec(rest);
    if (a) {
      anchor = a[1];
      rest = rest.slice(a[0].length);
      if (rest && !rest.startsWith("#") && splitKey(rest, no)) fail(no, "an anchor before a key is not read here");
    }
    if (rest.startsWith("!")) fail(no, "a tag is not read here");
    let out;
    if (rest === "" || rest.startsWith("#")) {
      const j = next(i + 1);
      if (j < lines.length && lines[j].indent > n) out = node(j, n);
      else if (j < lines.length && !inSeq && lines[j].indent === n && isItem(lines[j].text)) out = sequence(j, n);
      else out = [null, i + 1];
    } else if (rest[0] === "*") {
      const m = /^\*(\S+)\s*(#.*)?$/.exec(rest);
      if (!m) fail(no, "text after an alias");
      out = [alias(m[1], no), i + 1];
    } else if (rest[0] === "|" || rest[0] === ">") out = blockScalar(rest, n, i);
    else if (rest[0] === "[" || rest[0] === "{") {
      const [s, k] = flowText(rest, i);
      out = [parseFlow(s, no), k];
    } else if (rest[0] === '"' || rest[0] === "'") out = quoted(rest, i);
    else if (/^[%@`]/.test(rest)) fail(no, `a plain scalar cannot start with ${rest[0]}`);
    else out = plain(rest, n, i);
    if (anchor !== undefined) anchors.set(anchor, out[0]);
    return out;
  };

  const mapping = (j, m) => {
    const obj = {};
    Object.defineProperty(obj, LINE, { value: lines[j].no });
    let i = j;
    for (;;) {
      i = next(i);
      if (i >= lines.length || lines[i].indent < m) break;
      const l = lines[i];
      if (l.indent > m) fail(l.no, "a line more indented than its mapping");
      if (l.text.startsWith("\t")) fail(l.no, "a tab in the indentation");
      if (isItem(l.text)) fail(l.no, "a sequence item where a key was expected");
      const sk = splitKey(l.text, l.no);
      if (!sk) fail(l.no, "a key was expected");
      const [k, rest] = sk;
      if (k === "<<") fail(l.no, "a merge key (<<) is not read here");
      if (Object.hasOwn(obj, k)) fail(l.no, `the key ${k} appears twice`);
      const [v, after] = value(rest, m, i, false);
      setKey(obj, k, v);
      i = after;
    }
    return [obj, i];
  };

  const sequence = (j, d) => {
    const arr = [];
    const itemLines = [];
    Object.defineProperty(arr, ITEM_LINES, { value: itemLines });
    let i = j;
    for (;;) {
      i = next(i);
      if (i >= lines.length || lines[i].indent < d) break;
      const l = lines[i];
      if (l.indent > d) fail(l.no, "a line more indented than its sequence");
      if (!isItem(l.text)) break; // a key at the sequence's indent belongs to the mapping above
      const after = l.text.slice(1);
      const content = after.trimStart();
      const off = 1 + after.length - content.length;
      itemLines.push(l.no);
      let v;
      let k;
      if (content === "" || content.startsWith("#")) [v, k] = value("", d, i, true);
      else if (isItem(content) || (!content.startsWith("&") && splitKey(content, l.no))) {
        lines[i] = { ...l, indent: d + off, text: content };
        [v, k] = isItem(content) ? sequence(i, d + off) : mapping(i, d + off);
      } else [v, k] = value(content, d, i, true);
      arr.push(v);
      i = k;
    }
    return [arr, i];
  };

  const node = (j, parent) => {
    const l = lines[j];
    if (l.text.startsWith("\t")) fail(l.no, "a tab in the indentation");
    if (isItem(l.text)) return sequence(j, l.indent);
    if (!l.text.startsWith("&") && splitKey(l.text, l.no)) return mapping(j, l.indent);
    return value(l.text, parent, j, false);
  };

  let seen = false;
  for (const l of lines) {
    if (blank(l)) continue;
    if (l.indent === 0 && /^---(\s|$)/.test(l.text)) {
      if (seen) fail(l.no, "a second document");
      if (cutComment(l.text.slice(3))) fail(l.no, "content on the --- line is not read here");
      l.text = "";
    } else if (l.indent === 0 && /^(\.\.\.(\s|$)|%)/.test(l.text)) fail(l.no, "a directive or a document end is not read here");
    else seen = true;
  }
  const first = next(0);
  if (first >= lines.length) return null;
  const [doc, end] = node(first, -1);
  const extra = next(end);
  if (extra < lines.length) fail(lines[extra].no, "text after the document");
  return doc;
}

// ---- Telemetry opt-outs of the tools the workflows run (PG-D14) ---------------------------------------------------
const GH_RUN = /(^|[\s$(`;|&])gh\s+(api|release|issue|label|run|pr|workflow|repo|auth|attestation|search|cache|secret|variable)\b/m;
const JS_RUN = /(^|[\s$(`;|&])(pnpm\s+[^\s;&|)]|turbo\b)/m;
const GH_FALSEY = ["", "0", "false", "no", "disabled", "off"]; // cli/cli internal/telemetry/telemetry.go falseyValues, read trimmed and lower-cased
const PWSH = /^(pwsh|powershell)(\s|$)/i;
// pwsh or powershell (.exe too, in any case) started as a command: at the script's start or after white space, $, (,
// ;, &, | or a backtick, or in quotes after sh -c, bash -c, dash -c, zsh -c or ksh -c, with any options before the
// -c, each with one argument or none (bash -c "pwsh ...", bash -lc, bash -o pipefail -c, bash --login -c, bash +o
// posix -c); by its name or by a path whose last part it
// is (/usr/bin/pwsh, C:/tools/pwsh.exe, ~/.dotnet/tools/pwsh, $HOME/.dotnet/tools/pwsh, ./pwsh7/pwsh, or in quotes,
// which may hold spaces: "C:/Program Files/PowerShell/7/pwsh.exe"; not after =, so PWSH=/usr/bin/pwsh is no start);
// then white space, a quote, <, >, ;, & or | follows, or the end (B0-U01, inspection 6: m3; inspection 7: n2;
// inspection 8: p1).
const PWSH_RUN = new RegExp(
  String.raw`(?:^|[\s$(\x60;|&]|(?:^|[\s/;|&(\x60])(?:ba|da|z|k)?sh\s+` +
    String.raw`(?:[-+]{1,2}[a-z][\w-]*(?:\s+(?![-+])[^\s"'\x60;|&<>()]+)?\s+)*-[a-z]*c\s+["'])` +
    String.raw`(?:[^\s"'\x60;|&<>()=]*[\\/]|(?<q>["'])[^"'\n]*[\\/])?` +
    String.raw`(?:pwsh|powershell)(?:\.exe)?\k<q>(?=[\s"'<>;|&]|$)`,
  "i",
);
const EXPR = /\$\{\{([\s\S]*?)\}\}/g;
const str = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? "\u0000" : String(v));
const asMap = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
// The command substitutions in an echo's or printf's text: each $( ) span (to its matching ), or to the end of the text
// where the cut ends it first) and each ` ` span, outside single quotes. A backslash escapes the next character, but
// not in single quotes; in $'...' it does. An unquoted # that starts a word begins a comment, which ends the text. The
// shell runs the spans before it prints, so they are code (B0-U01, inspection 6: B2; inspection 7: n1, n4).
const substitutions = (text) => {
  const spans = [];
  let quote = "";
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote === "'") {
      if (c === "'") quote = "";
    } else if (quote === "$'") {
      if (c === "\\") k++;
      else if (c === "'") quote = "";
    } else if (c === "\\") k++;
    else if (c === "$" && text[k + 1] === "'" && !quote) {
      quote = "$'";
      k++;
    } else if (c === "'" && !quote) quote = "'";
    else if (c === "#" && !quote && /\s/.test(text[k - 1])) break;
    else if (c === '"') quote = quote ? "" : '"';
    else if (c === "`" || (c === "$" && text[k + 1] === "(")) {
      let end = k + 1;
      if (c === "`") while (end < text.length && text[end] !== "`") end++;
      else {
        for (let depth = 0; end < text.length; end++) {
          if (text[end] === "(") depth++;
          else if (text[end] === ")" && --depth === 0) break;
        }
      }
      spans.push(text.slice(k, end + 1));
      k = end;
    }
  }
  return spans;
};
// A run: script's code: comment lines dropped, and what an echo or printf prints, up to the next ; & or |, cut out
// but for its command substitutions, so a message that names a command is not a run of it.
const codeOf = (run) =>
  str(run)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\b(echo|printf)\b[^;&|]*/g, (text) => substitutions(text).join(" ")))
    .join("\n");
const ghOff = (env) =>
  Object.hasOwn(env, "GH_TELEMETRY") ? GH_FALSEY.includes(str(env.GH_TELEMETRY).trim().toLowerCase()) : ["1", "true"].includes(str(env.DO_NOT_TRACK).trim().toLowerCase());
const jsOff = (env) => ["1", "true"].includes(str(env.DO_NOT_TRACK)) || ["1", "true"].includes(str(env.TURBO_TELEMETRY_DISABLED));
const pwshOff = (env) => /^(1|true|yes)$/i.test(str(env.POWERSHELL_TELEMETRY_OPTOUT));

// The values a ${{ }} expression can take, when the check can tell: matrix.<path> from the matrix's lists and its
// include entries, or the JSON lists quoted in a fromJSON expression. Else null.
function exprValues(expr, matrix) {
  const e = expr.trim();
  const m = /^matrix((?:\.[\w-]+)+)$/.exec(e);
  if (m) {
    if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return null;
    const [head, ...path] = m[1].slice(1).split(".");
    let vals = [];
    const top = matrix[head];
    if (top !== undefined && top !== null) {
      const list = typeof top === "string" ? textValues(top, null) : Array.isArray(top) ? top : [top];
      if (list === null) return null;
      vals.push(...list);
    }
    if (matrix.include !== undefined && matrix.include !== null) {
      if (!Array.isArray(matrix.include)) return null;
      for (const entry of matrix.include) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        if (entry[head] !== undefined) vals.push(entry[head]);
      }
    }
    for (const p of path) vals = vals.map((v) => (v && typeof v === "object" && !Array.isArray(v) ? v[p] : undefined));
    return vals.length && !vals.some((v) => v === undefined) ? vals : null;
  }
  if (/\bfromJSON\s*\(/i.test(e)) {
    const lists = [];
    for (const q of e.matchAll(/'((?:[^']|'')*)'/g)) {
      try {
        const v = JSON.parse(q[1].replaceAll("''", "'"));
        if (Array.isArray(v)) lists.push(...v);
      } catch {
        // a quoted string that is not a JSON list (a comparison operand, say)
      }
    }
    return lists.length ? lists : null;
  }
  return null;
}
// The values a text that may hold ${{ }} can take: an expression's values when it is one expression, else the text
// itself. runnersOf reads every value by its literal part, the text without its expressions, which then decides: an
// expression's own text (${{ vars.LINUX_POOL }}) says nothing of its value (B0-U01, inspection 6: S14; read in that
// one place since inspection 8's p2).
function textValues(text, matrix) {
  const parts = [...text.matchAll(EXPR)];
  return parts.length === 1 && parts[0][0] === text.trim() ? exprValues(parts[0][1], matrix) : [text];
}
// Every runner a job's runs-on can name, each a list of labels, or null for one the check cannot resolve.
// A label of the list and group forms is read by its text without its expressions, as a runs-on text that mixes the
// two is: a label that is only an expression (${{ vars.LINUX_POOL }}) names no OS (B0-U01, inspection 7: n3). So is
// a value the matrix gives, and each label of a list it gives (inspection 8: p2).
function runnersOf(job) {
  const ro = job["runs-on"];
  const literal = (labels) => labels.map((l) => str(l).replace(EXPR, ""));
  if (ro === undefined || ro === null) return [null];
  if (Array.isArray(ro)) return [literal(ro)];
  if (typeof ro === "object") return [Array.isArray(ro.labels) ? literal(ro.labels) : ro.labels != null ? literal([ro.labels]) : null];
  const vals = textValues(str(ro), job.strategy?.matrix);
  if (vals === null) return [null];
  return vals.map((v) => (Array.isArray(v) ? literal(v) : v && typeof v === "object" ? null : literal([v])));
}
const maybeWindows = (labels) => labels === null || labels.some((l) => /windows/i.test(l)) || !labels.some((l) => /ubuntu|linux|macos/i.test(l));

// Whether a local action (uses: ./path) runs pwsh, on a runner that may be Windows or not: any local composite action
// with a pwsh step, or a step whose script starts pwsh, does on every runner, since an action can be used from any job
// (B0-U01, inspection 7: n2); the template's toxiproxy and standard-user actions do where the runner may be Windows,
// because their pwsh steps are their Windows steps. One the reader cannot read counts. A step that uses another local
// action is followed (its ./ path read from the repository's root, as a job's is): an action already on the way is not
// read again, and one more than ten actions deep counts, as one the reader cannot read does (inspection 8: p3).
function localActionRunsPwsh(uses, root, windows, path = []) {
  if (!uses.startsWith("./")) return false;
  const dir = uses.replace(/^\.\//, "").replace(/\/+$/, "");
  if (/^\.github\/actions\/(toxiproxy|standard-user)$/.test(dir)) return windows;
  if (path.includes(dir)) return false;
  if (path.length >= 10) return true;
  const file = ["action.yml", "action.yaml"].map((n) => join(root, dir, n)).find((f) => existsSync(f));
  if (!file) return false;
  try {
    const steps = parseYaml(readFileSync(file, "utf8"))?.runs?.steps;
    const nested = (s) => typeof s?.uses === "string" && localActionRunsPwsh(s.uses.trim(), root, windows, [...path, dir]);
    return Array.isArray(steps) && steps.some((s) => PWSH.test(str(s?.shell).trim()) || PWSH_RUN.test(codeOf(s?.run)) || nested(s));
  } catch {
    return true;
  }
}

function runStepProblems(rel, where, steps, base, scope) {
  const out = [];
  steps.forEach((s, k) => {
    if (!s || typeof s !== "object" || s.run === undefined) return;
    const env = { ...base, ...asMap(s.env) };
    const code = codeOf(s.run);
    const at = `${rel}:${steps[ITEM_LINES]?.[k] ?? s[LINE]}`;
    if (GH_RUN.test(code) && !ghOff(env)) out.push(`${at}: a step that runs gh (${where}) has no telemetry opt-out: set GH_TELEMETRY: "0" in ${scope}, or DO_NOT_TRACK: "1" with GH_TELEMETRY unset (PG-D14)`);
    if (JS_RUN.test(code) && !jsOff(env)) out.push(`${at}: a step that runs pnpm or turbo (${where}) has neither DO_NOT_TRACK nor TURBO_TELEMETRY_DISABLED set to 1 or true in ${scope} (PG-D14)`);
  });
  return out;
}

function pwshJobProblems(rel, doc, id, job, root) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const windows = runnersOf(job).filter(maybeWindows);
  const on = [...new Set(windows.map((r) => (r === null ? "a runner this check cannot resolve" : r.join(", "))))].join("; ");
  const fallback = job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
  for (const [k, s] of steps.entries()) {
    if (!s || typeof s !== "object") continue;
    let why = null;
    if (s.run !== undefined) {
      const shell = s.shell ?? fallback;
      if (shell !== undefined && shell !== null) {
        if (PWSH.test(str(shell).trim()) || str(shell).includes("${{")) why = `a run: step with shell: ${str(shell)}`;
      } else if (windows.length) why = `a run: step with no shell: on ${on}, where the default is pwsh`;
      // pwsh started as a command from the script, on any runner (inspection 6: m3).
      why ??= PWSH_RUN.test(codeOf(s.run)) ? "a run: step whose script starts pwsh or powershell" : null;
    } else if (typeof s.uses === "string" && localActionRunsPwsh(s.uses.trim(), root, windows.length > 0)) {
      why = windows.length ? `${s.uses.trim()} on ${on}` : s.uses.trim();
    }
    if (why && !pwshOff({ ...asMap(doc.env), ...asMap(job.env), ...asMap(s.env) })) {
      return [`${rel}:${steps[ITEM_LINES]?.[k] ?? job[LINE]}: job ${id} runs pwsh (${why}) without POWERSHELL_TELEMETRY_OPTOUT set to 1, true or yes in the workflow, job or step env (PG-D14)`];
    }
  }
  return [];
}

// The telemetry problems of one parsed workflow (.github/workflows/*) or composite action.
export function telemetryProblems(rel, doc, root = ".") {
  const out = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  if (/^\.github\/workflows\//.test(rel)) {
    for (const [id, job] of Object.entries(asMap(doc.jobs))) {
      if (!job || typeof job !== "object" || Array.isArray(job)) continue;
      const steps = Array.isArray(job.steps) ? job.steps : [];
      out.push(...runStepProblems(rel, `jobs.${id}`, steps, { ...asMap(doc.env), ...asMap(job.env) }, "the workflow, job or step env"));
      out.push(...pwshJobProblems(rel, doc, id, job, root));
    }
  } else if (str(asMap(doc.runs).using) === "composite") {
    const steps = Array.isArray(doc.runs.steps) ? doc.runs.steps : [];
    out.push(...runStepProblems(rel, "runs.steps", steps, {}, "the step's own env"));
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(join(dir, e.name)));
    } else out.push(join(dir, e.name));
  }
  return out;
}

function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: "." },
      profile: { type: "string", default: "app" },
    },
  });
  const root = values.root;
  if (!Object.hasOwn(REQUIRED, values.profile)) {
    console.error(`unknown profile ${values.profile}`);
    process.exit(2);
  }

  const problems = [];
  const nonEmpty = (p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile() && readFileSync(join(root, p), "utf8").trim().length > 0;

  for (const f of REQUIRED[values.profile]) if (!nonEmpty(f)) problems.push(`${f} is missing or empty`);

  if (values.profile === "app") {
    // .github/PULL_REQUEST_TEMPLATE.md in either letter case.
    const prTemplate = ["PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"].some((n) => nonEmpty(`.github/${n}`));
    if (!prTemplate) problems.push(".github/PULL_REQUEST_TEMPLATE.md is missing or empty");

    // The notices for bundled third-party code, under either conventional name.
    if (!["THIRD-PARTY-NOTICES.md", "NOTICE", "NOTICE.md"].some(nonEmpty)) problems.push("THIRD-PARTY-NOTICES.md (or NOTICE) is missing or empty");

    const licensesDir = join(root, "LICENSES");
    const hasLicenses = existsSync(licensesDir) && readdirSync(licensesDir).some((n) => nonEmpty(`LICENSES/${n}`));
    if (!nonEmpty("LICENSE") && !nonEmpty("COPYING") && !hasLicenses) problems.push("no licence: add LICENSE (or COPYING) or a REUSE LICENSES/ directory");

    if (nonEmpty(".gitignore")) {
      const ignore = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
      if (!ignore.some((l) => /^\/?internal\/?$/.test(l))) problems.push(".gitignore does not ignore internal/ (internal specifications stay out of the repository)");
    }
  }

  // .gitignore does not stop `git add -f`, so ask git what it tracks there (every
  // profile: internal documents never reach any repository).
  if (existsSync(join(root, ".git"))) {
    const r = spawnSync("git", ["ls-files", "--", "internal"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) problems.push(`git ls-files failed (${(r.stderr ?? "").trim()}), so internal/ could not be checked`);
    for (const f of (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
      problems.push(`${f} is tracked: internal documents stay out of the repository (git rm --cached, then rotate anything secret in it)`);
    }
  }

  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (!TEXT.test(rel) || statSync(file).size > 1024 * 1024) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => PLACEHOLDER.test(l));
    if (at !== -1) problems.push(`${rel}:${at + 1}: a template placeholder is left (${lines[at].match(PLACEHOLDER)[0]})`);

    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) {
      if (!/^permissions:/m.test(text)) problems.push(`${rel}: no top-level permissions block (least privilege: start from "permissions: {}" or "contents: read")`);
      if (/\bpull_request_target\b/.test(text)) problems.push(`${rel}: uses pull_request_target, which runs with secrets on code from forks`);
      problems.push(...hardenRunnerProblems(rel, lines));
    }
    if (/^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml)$/.test(rel)) {
      lines.forEach((l, i) => {
        const m = l.match(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)/);
        if (!m) return;
        const ref = m[1];
        if (ref.startsWith("./") || ref.startsWith("docker://")) return;
        if (!/@[0-9a-f]{40}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned to a full commit SHA`);
      });
      let doc;
      try {
        doc = parseYaml(text);
      } catch (e) {
        problems.push(`${rel}: could not be read as YAML (${e.message}), so its telemetry opt-outs were not checked`);
      }
      if (doc !== undefined) problems.push(...telemetryProblems(rel, doc, root));
    }
  }

  const summary = problems.length
    ? `### Repository hygiene: ${problems.length} problem(s)\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`
    : "### Repository hygiene: no problems\n";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exit(problems.length ? 1 : 0);
}

// Real paths on both sides: Node gives import.meta.url as the module's real path, so a script path or working folder
// through a junction or symlink would not match the path as typed, and the command would exit 0 having checked nothing
// (B0-U02's inspector 8, N1; B0-U01 round 8).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) main();
