#!/usr/bin/env node
// The installer-contract checker (S-12, program-plan I-12). Reads one Inno Setup script and, optionally, the ISCC compile
// log, the notices files, the install documentation and the previous release's script. Each finding names its rule id
// (CONTRACT.md) and the line of the defect. Node standard library only.
//
// Usage: node check-installer.mjs <app.iss> [--log iscc.log] [--notices FILE]... [--docs FILE]... [--previous old.iss]
//        [--include-dir DIR]... [--json]
// Exit code: 0 no findings, 1 findings, 2 usage or read error.
//
// A line `#include "file.iss"` is read as if the file's text stood in its place (as ISPP does), so an include such as
// PerfWindow's PawnIO include is checked like the script itself. A finding in an include names that file and its own line.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = {
  'IC-0': 'The script declares its profile, has no unfilled template placeholder, and every #include can be read',
  'IC-1': 'Inno Setup 7.1.1 only: a version guard in the script, and 7.1.1 in the compile log',
  'IC-2': 'A 64-bit Setup and uninstaller that installs in 64-bit mode: SetupArchitecture=x64 and ArchitecturesInstallIn64BitMode naming x64, or the Arm64 form (ArchitecturesAllowed=arm64 as well, and the -windows-arm64 name)',
  'IC-3': 'UninstallLogging=yes',
  'IC-4': 'UsedUserAreasWarning is an error: never switched off, and no such warning in the compile log',
  'IC-5': 'An elevated script names no per-user area and deletes nothing per-user',
  'IC-6': 'runasoriginaluser only in [Run]; ExecAsOriginalUser never at uninstall',
  'IC-7': 'An update hand-off is /UPDATE=1, never Check: WizardSilent',
  'IC-8': 'System32 commands are built from {sys}',
  'IC-9': 'A fixed folder for an app whose files run elevated or as a service: the directives',
  'IC-10': 'A fixed folder: PrepareToInstall refuses any other folder and runs the link-safe check',
  'IC-11': 'A fixed folder: the earlier installation is found from the _is1 key in both registry views, and the rights half of D23 is named',
  'IC-12': 'System changes are undone before the first file is removed, and failure aborts; [UninstallRun] only to supersede an inherited entry (the RunOnceId of one in the previous script)',
  'IC-13': 'Every installed file carries uninsrestartdelete, and no restartreplace binary is run or registered',
  'IC-14': 'Uninstall is refused while a pending rename targets the install folder',
  'IC-15': '[InstallDelete] entries are explicit: no wildcard, no whole folder',
  'IC-16': 'No SignTool, no signed uninstaller, no sign flag',
  'IC-17': 'No .NET runtime and no VC++ runtime ships or runs from the installer',
  'IC-18': 'The notices ship, with the Inno Setup notice and the Pascal Script about-line',
  'IC-19': 'The silent uninstall is documented with /NORESTART',
  'IC-20': 'With the aumid profile every shortcut sets AppUserModelID',
  'IC-21': 'A refused install is a PrepareToInstall refusal (Setup exit code 7): no Abort, Halt or process exit in PrepareToInstall or in a routine it calls',
  'IC-22': 'An update keeps the previous release\'s AppId, install folder, exe names and asset-name pattern',
};

const PROFILE_TOKENS = ['none', 'fixed-folder', 'system-changes', 'aumid'];

const SYSTEM_TOOLS = ['sc', 'taskkill', 'powershell', 'cmd', 'reg', 'schtasks', 'icacls', 'takeown', 'netsh', 'regsvr32',
  'rundll32', 'msiexec', 'pnputil', 'fltmc', 'dism', 'net', 'net1', 'wevtutil', 'wusa', 'cscript', 'wscript', 'mshta',
  'certutil', 'bcdedit', 'attrib', 'cacls', 'fsutil', 'setx', 'shutdown', 'tasklist', 'whoami', 'wmic', 'bitsadmin',
  'secedit', 'robocopy', 'xcopy', 'mountvol', 'vssadmin', 'wbadmin', 'diskpart', 'sfc', 'bcdboot'];

// ISPP's {%NAME|default} environment constants, GetEnv('NAME'), and the %NAME% and $env:NAME of a command string (cmd.exe and
// PowerShell expand them though Exec does not) that reach a per-user folder.
const USER_ENV_RE = /\{%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)\b[^}]*\}|\bGetEnv\s*\(\s*'(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)'|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)%|\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)\b/i;

// What a script that changes the system outside its own folder says: a scheduled task, a service, a package, a registered DLL.
const SYSTEM_CHANGE_RE = /\bschtasks(?:\.exe)?\b|\bregsvr32(?:\.exe)?\b|\bNew-Service\b|\bRegister-ScheduledTask\b|\bAdd-Appx(?:Provisioned)?Package\b|\bAdd-AppPackage\b|\bbinPath\s*=|\bCreateService\b/i;

// [Files] flags of an entry that is never kept in the install folder.
const NOT_KEPT_FLAGS = ['dontcopy', 'deleteafterinstall', 'uninsneveruninstall'];

const USER_AREA_CONSTANTS = ['userappdata', 'localappdata', 'userdocs', 'userdesktop', 'userfavorites', 'usersavedgames',
  'userstartmenu', 'userstartup', 'userprograms', 'usertemplates', 'userpf', 'usercf', 'usersendto', 'userfonts'];

const USER_AREA_RE = new RegExp(`\\{(${USER_AREA_CONSTANTS.join('|')})\\}`, 'i');

const RUNTIME_PATTERNS = [
  /vc[_-]?redist/i, /vcruntime\d*(_\d+)?\.dll/i, /msvcp\d*(_\d+)?\.dll/i, /msvcr\d+\.dll/i, /ucrtbase\.dll/i,
  /api-ms-win-crt/i, /concrt\d*\.dll/i, /vcomp\d*\.dll/i, /vccorlib\d*\.dll/i,
  /windowsdesktop-runtime/i, /dotnet-runtime/i, /dotnet-sdk/i, /aspnetcore-runtime/i, /dotnet-hosting/i,
  /dotnet-install/i, /\bndp\d+/i, /netfx/i,
];

// A file name that only one of these reads is a presence test, not an extract, a download or a run (IC-17).
const DETECT_CALLS = ['fileexists', 'direxists', 'filesearch', 'getversionnumbers', 'getversionnumbersstring'];
// Calls that only build or cut a path: a name inside one of them is still the argument of the call outside it.
const PATH_CALLS = ['expandconstant', 'addbackslash', 'removebackslash', 'addperiod', 'extractfilepath', 'extractfiledir',
  'extractfilename', 'extractfileext', 'extractrelativepath', 'changefileext', 'lowercase', 'uppercase', 'trim'];
// Calls that run, extract or download what they are given, or what a presence test hands them (FileSearch returns a path).
const USE_CALLS = ['exec', 'execasoriginaluser', 'shellexec', 'shellexecasoriginaluser', 'extracttemporaryfile',
  'extracttemporaryfiles', 'downloadtemporaryfile'];

const UNINSTALL_EVENTS = ['InitializeUninstall', 'CurUninstallStepChanged', 'DeinitializeUninstall',
  'UninstallNeedRestart', 'InitializeUninstallProgressForm'];

// The Arm64 form of IC-2 names the architecture identifier `arm64` alone (Inno Setup reads the identifiers in any case).
const ARM64_RE = /^\s*arm64\s*$/i;

/**
 * True when a parsed script is in the Arm64 form of IC-2, read from either directive: ArchitecturesAllowed=arm64 or
 * ArchitecturesInstallIn64BitMode=arm64. IC-2 then requires both, and the D-A name `-windows-arm64`.
 */
function arm64Form(script) {
  const get = (k) => script.setup.get(k)?.value ?? '';
  return ARM64_RE.test(get('architecturesallowed')) || ARM64_RE.test(get('architecturesinstallin64bitmode'));
}

// ---------------------------------------------------------------- parsing

function splitParams(text) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (const ch of text) {
    if (ch === '"') inQ = !inQ;
    if (ch === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const out = {};
  for (const p of parts) {
    const m = /^\s*([A-Za-z]\w*)\s*:\s*([\s\S]*?)\s*$/.exec(p);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/""/g, '"');
    out[m[1].toLowerCase()] = v;
  }
  return out;
}

/**
 * Expand `{#Name}` from the script's `#define` lines. `keep` names defines that stay a token: IC-22 compares the asset-name
 * pattern, so `{#AppVersion}` must not become each script's own `#ifndef AppVersion` fallback ("2.0.0" in an old script, "0.0.0"
 * in the template), which would make the same pattern look like two names (fix round 2).
 */
function expandDefines(lines, keep = []) {
  const kept = new Set(keep.map((n) => n.toLowerCase()));
  const defs = new Map();
  for (const l of lines) {
    // ISPP also takes `# define` (a space after the hash), as it does `# include`.
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+(?:"([^"]*)"|(\S+))\s*$/i.exec(l);
    if (m) defs.set(m[1], m[2] ?? m[3]);
  }
  const expand = (l) => {
    if (/^\s*#\s*define\b/i.test(l)) return l;
    let cur = l;
    for (let i = 0; i < 5 && /\{#[A-Za-z_]\w*\}/.test(cur); i++) {
      cur = cur.replace(/\{#([A-Za-z_]\w*)\}/g, (all, n) => (defs.has(n) && !kept.has(n.toLowerCase()) ? defs.get(n) : all));
    }
    return cur;
  };
  return lines.map(expand);
}

/** Blank the comments of Pascal code, keep strings and newlines, so offsets and line numbers still hold. */
function maskPascal(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } break; }
        if (src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '{') {
      while (i < n && src[i] !== '}') { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += ' '; i++; }
    } else if (c === '(' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === ')')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else {
      out += c;
      i++;
    }
  }
  // ISPP directive lines in the code (#ifdef, #endif) are not Pascal.
  return out.split('\n').map((l) => (/^\s*#[A-Za-z]/.test(l) ? ' '.repeat(l.length) : l)).join('\n');
}

/**
 * The top-level arguments of the call whose "(" stands at `open` in `src` (Pascal code with its comments blanked and its strings
 * kept): [{ text, at }] with `at` the offset of each argument, or null when the brackets do not balance. A string with a
 * doubled quote ('it''s') is one string.
 */
function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && !(src[j] === "'" && src[j + 1] !== "'")) j += src[j] === "'" ? 2 : 1;
      i = j;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) { args.push({ text: src.slice(start, i), at: start }); return args; }
    } else if (c === ',' && depth === 1) {
      args.push({ text: src.slice(start, i), at: start });
      start = i + 1;
    }
  }
  return null;
}

/** The code with every string's content replaced by `x`: the same offsets and lines, and no word inside a string to match. */
const blankStrings = (text) => text.replace(/'(?:[^'\n]|'')*'/g, (lit) => `'${'x'.repeat(lit.length - 2)}'`);

/** The string literals of a Pascal expression joined (`'/c ' + X('{sys}\a.exe') + ' b'` gives `/c {sys}\a.exe b`). */
const literalsOf = (text) => [...text.matchAll(/'((?:[^'\n]|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")).join('');

// ISPP reads an include from `#include "f"`, and from the same directive with a space after the hash (`# include "f"`) or
// written `#+ "f"` (all three measured with ISCC 7.1.1: each compiled and read the file).
const INCLUDE_LINE = /^\s*#\s*(?:include\b|\+)(.*)$/i;
const MAX_INCLUDE_DEPTH = 8;

/**
 * The resolver of a name-to-text map (the tests and any caller that has the texts): a name is looked up next to the file that
 * includes it first, as ISPP does (measured: an include of `sub/b.iss` that names "c.iss" finds `sub/c.iss`, else the main
 * script's folder), then as written.
 */
function mapResolver(map) {
  return (name, from) => {
    const slash = name.replace(/\\/g, '/');
    const near = posix.normalize(posix.join(from === 'iss' ? '.' : posix.dirname(from), slash));
    for (const key of [near, name, slash, name.replace(/\//g, '\\')]) {
      if (Object.hasOwn(map, key)) return { key, text: map[key] };
    }
    return undefined;
  };
}

/**
 * Replace each include line (see INCLUDE_LINE) with the text of that file, as ISPP does. `includes` is a map from a name to the
 * file's text, or a function `(name, fromKey) => ({ key, text }) | undefined` that finds the file (the command line's, which
 * reads the disk and looks in the including file's folder, then the script's, then each --include-dir). Returns the expanded
 * text, the origin ({file, line}) of every expanded line, and the includes that could not be followed (unquoted, unread, a
 * loop, too deep). A `compiler:` name is the compiler's own and stays as a line.
 */
export function inlineIncludes(text, includes = {}) {
  const find = typeof includes === 'function' ? includes : mapResolver(includes);
  const lines = [];
  const origin = [];
  const problems = [];
  const walk = (src, file, stack) => {
    src.replace(/\r\n?/g, '\n').split('\n').forEach((l, i) => {
      const keep = () => { lines.push(l); origin.push({ file, line: i + 1 }); };
      const m = INCLUDE_LINE.exec(l);
      if (!m) return keep();
      const arg = m[1].trim();
      const lit = /^"([^"]+)"$/.exec(arg);
      const problem = (why) => { problems.push({ file, line: i + 1, message: `#include ${arg}: ${why}` }); keep(); };
      if (!lit) return problem('not a quoted file name, so the checker cannot follow it');
      const name = lit[1];
      if (/^compiler:/i.test(name)) return keep();
      const found = find(name, file);
      if (found === undefined) return problem('cannot be read (the checker looks next to the including file, next to the script and in --include-dir)');
      if (stack.includes(found.key)) return problem('includes itself again: an include loop');
      if (stack.length >= MAX_INCLUDE_DEPTH) return problem(`is nested more than ${MAX_INCLUDE_DEPTH} deep`);
      walk(found.text, found.key, [...stack, found.key]);
    });
  };
  walk(text, 'iss', []);
  return { text: lines.join('\n'), origin, problems };
}

function parse(text, keep = []) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const lines = expandDefines(raw, keep);
  const sections = [];
  let cur = { name: '', line: 1, rows: [] };
  sections.push(cur);
  for (let idx = 0; idx < lines.length; idx++) {
    const t = lines[idx];
    const h = /^\[([A-Za-z]+)\]\s*$/.exec(t);
    if (h) { cur = { name: h[1].toLowerCase(), line: idx + 1, rows: [] }; sections.push(cur); continue; }
    cur.rows.push({ n: idx + 1, text: t, raw: raw[idx] });
  }
  const iniRows = (name) => sections.filter((s) => s.name === name).flatMap((s) => s.rows)
    .filter((r) => r.text.trim() !== '' && !r.text.trim().startsWith(';') && !r.text.trim().startsWith('#'));
  const entries = (name) => iniRows(name).map((r) => ({ n: r.n, text: r.text, p: splitParams(r.text) }));

  const setup = new Map();
  for (const r of iniRows('setup')) {
    const m = /^\s*([A-Za-z]\w*)\s*=\s*(.*?)\s*$/.exec(r.text);
    if (m) setup.set(m[1].toLowerCase(), { value: m[2].replace(/^"(.*)"$/, '$1'), n: r.n });
  }

  // Code: Inno joins every [Code] section into one program (an include may carry its own), so the rows of all of them are
  // read as one text, and each row keeps the line it came from.
  const codeRows = sections.filter((s) => s.name === 'code').flatMap((s) => s.rows);
  const hasCode = sections.some((s) => s.name === 'code');
  const codeStart = codeRows.length ? codeRows[0].n : 0;
  const codeSrc = codeRows.map((r) => r.text).join('\n');
  const masked = hasCode ? maskPascal(codeSrc) : '';
  const lineAt = (off) => codeRows[Math.min(masked.slice(0, off).split('\n').length, codeRows.length) - 1]?.n ?? codeStart;
  // A routine header may carry event attributes, on the same line or on the lines above it: `<event('PrepareToInstall')>`
  // makes the routine one implementation of that event, whatever its own name (Inno Setup help, Event Attributes; an include
  // uses it to avoid a clash with the main script). A routine's text starts at its first attribute, so an attribute's string
  // is never read as part of the routine above it.
  const routines = [];
  const re = /^[ \t]*((?:<[^<>\n]*>[ \t]*)*)(procedure|function)[ \t]+([A-Za-z_]\w*)/gim;
  const attrTail = /<[ \t\r\n]*([A-Za-z_]\w*)[ \t\r\n]*(?:\([ \t\r\n]*'((?:[^']|'')*)'[ \t\r\n]*\))?[ \t\r\n]*>[ \t\r\n]*$/;
  let m;
  while ((m = re.exec(masked))) {
    const r = { name: m[3], off: m.index, kind: m[2].toLowerCase(), events: [] };
    for (const a of m[1].matchAll(/<\s*event\s*\(\s*'((?:[^']|'')*)'\s*\)\s*>/gi)) r.events.push(a[1]);
    r.start = r.off;
    for (let head = masked.slice(0, r.off), t; (t = attrTail.exec(head)); head = head.slice(0, t.index)) {
      if (t[1].toLowerCase() === 'event' && t[2] !== undefined) r.events.push(t[2]);
      r.start = t.index;
    }
    routines.push(r);
  }
  routines.forEach((r, i) => {
    r.end = i + 1 < routines.length ? routines[i + 1].start : masked.length;
    r.text = masked.slice(r.off, r.end);
    r.line = lineAt(r.off);
  });
  const routine = (name) => routines.find((r) => r.name.toLowerCase() === name.toLowerCase());
  // Every implementation of an event: the routine of that name, and every routine that carries the attribute for it.
  const impls = (name) => routines.filter((r) => r.name.toLowerCase() === name.toLowerCase()
    || r.events.some((e) => e.toLowerCase() === name.toLowerCase()));
  const reach = (starts) => {
    const seen = new Set();
    const queue = starts.flatMap(impls);
    while (queue.length) {
      const r = queue.pop();
      if (seen.has(r)) continue;
      seen.add(r);
      // A routine is called by name in code; the same word inside a message string is no call.
      const code = blankStrings(r.text);
      for (const o of routines) if (!seen.has(o) && o !== r && new RegExp(`\\b${o.name}\\b`, 'i').test(code)) queue.push(o);
    }
    return [...seen];
  };
  return { raw, lines, sections, iniRows, entries, setup, masked, codeRows, codeStart, lineAt, routines, routine, impls, reach,
    hasCode };
}

// ---------------------------------------------------------------- the checks

/**
 * Reads one script (and the optional log, notices, docs and previous script of `input`) and returns the findings, which fail a
 * run, and the notes, which do not: what the checker could not read from the text (a wildcard Source in the previous script).
 */
export function analyse(input) {
  const findings = [];
  const notes = [];
  const exp = inlineIncludes(input.iss, input.resolveInclude ?? input.includes ?? {});
  // A finding of the script is mapped back to the file and line it was written in (an include has its own).
  const add = (rule, line, message, file = 'iss') => {
    let at = { file, line: line ?? 1 };
    if (file === 'iss' && exp.origin.length) at = exp.origin[Math.min(Math.max(at.line, 1), exp.origin.length) - 1];
    findings.push({ rule, line: at.line, message, file: at.file });
  };
  for (const p of exp.problems) findings.push({ rule: 'IC-0', line: p.line, message: p.message, file: p.file });
  const truthy = (v) => /^(yes|true|1)$/i.test(v ?? '');
  const s = parse(exp.text);
  // The previous release's script, when the build passes it (IC-12's superseding entry, IC-22 and the notes read it).
  const prevS = input.previous != null ? parse(input.previous) : null;
  const set = (k) => s.setup.get(k.toLowerCase());
  const setupLine = s.sections.find((x) => x.name === 'setup')?.line ?? 1;

  // The ini-style text of every section but [Code], comments removed, with its line, and the masked code lines.
  const textLines = [];
  for (const sec of s.sections) {
    if (sec.name === 'code') continue;
    for (const r of sec.rows) {
      const t = r.text.trim();
      if (t === '' || t.startsWith(';') || t.startsWith('#')) continue;
      textLines.push({ n: r.n, text: r.text, section: sec.name });
    }
  }
  const codeLines = s.hasCode ? s.masked.split('\n').map((text, i) => ({ n: s.codeRows[i].n, text, section: 'code' })) : [];
  const allLines = [...textLines, ...codeLines];

  // IC-0 ---------------------------------------------------------------
  let profile = null;
  let profileLine = 1;
  let d23 = null;
  s.raw.forEach((l, i) => {
    let m = /^\s*;\s*ic-profile:\s*(.*?)\s*$/i.exec(l);
    if (m && !profile) { profile = m[1].split(/\s+/).filter(Boolean); profileLine = i + 1; }
    m = /^\s*;\s*ic-d23-rights:\s*(.*?)\s*$/i.exec(l);
    if (m) d23 = { text: m[1], n: i + 1 };
    if (/\{\{tpl:[A-Z0-9_]+\}\}/.test(l)) add('IC-0', i + 1, 'unfilled template placeholder: ' + /\{\{tpl:[A-Z0-9_]+\}\}/.exec(l)[0]);
  });
  const has = (t) => (profile ?? []).includes(t);
  if (!profile || profile.length === 0) {
    add('IC-0', 1, 'no "; ic-profile: ..." line: declare fixed-folder, system-changes, aumid, or none');
    profile = [];
  } else {
    for (const t of profile) if (!PROFILE_TOKENS.includes(t)) add('IC-0', profileLine, `unknown profile token "${t}"`);
    if (profile.includes('none') && profile.length > 1) add('IC-0', profileLine, 'the profile "none" cannot be combined with another token');
  }

  // IC-1 ---------------------------------------------------------------
  const guardIdx = s.lines.findIndex((l) => /^\s*#if\s+Ver\s*!=\s*EncodeVer\(\s*7\s*,\s*1\s*,\s*1\s*\)\s*$/i.test(l));
  if (guardIdx < 0) {
    const other = s.lines.findIndex((l) => /^\s*#if\s+Ver\b/i.test(l));
    add('IC-1', other >= 0 ? other + 1 : 1, 'no "#if Ver != EncodeVer(7,1,1)" guard: Inno Setup 7.1.1 is the one version');
  } else if (!s.lines.slice(guardIdx + 1, guardIdx + 4).some((l) => /^\s*#error\b/i.test(l))) {
    add('IC-1', guardIdx + 1, 'the version guard has no #error');
  }
  if (input.log != null) {
    const ll = input.log.replace(/\r\n?/g, '\n').split('\n');
    const vi = ll.findIndex((l) => /^Compiler engine version:/i.test(l));
    if (vi < 0) {
      add('IC-1', 1, 'the compile log has no "Compiler engine version:" line (a quiet compile, ISCC -q, prints nothing and hides every warning: run ISCC without it)', 'log');
    } else {
      const v = /Inno Setup\s+(\S+)/i.exec(ll[vi])?.[1];
      if (v !== '7.1.1') add('IC-1', vi + 1, `the compile log names Inno Setup ${v ?? '(unreadable)'}; only 7.1.1 is allowed`, 'log');
    }
    // ISCC 7.1.1 prints the warning as text ("Warning: ... per-user areas (HKCU) ... the "UsedUserAreasWarning" topic ...")
    // and, with --messages-jsonl, as one JSON line. Both name the directive, so any line that does is a finding.
    ll.forEach((l, i) => {
      if (/UsedUserAreasWarning/i.test(l)) {
        add('IC-4', i + 1, 'the compile log holds the UsedUserAreasWarning warning: it is an error here', 'log');
      }
    });
  }

  // IC-2, IC-3, IC-4 ---------------------------------------------------
  // The script with `{#AppVersion}` kept as a token (IC-2's Arm64 name and IC-22's asset name are patterns).
  const nk = parse(exp.text, ['AppVersion']);
  const arch = set('ArchitecturesInstallIn64BitMode');
  const allowed = set('ArchitecturesAllowed');
  if (!arch || arch.value === '') add('IC-2', arch?.n ?? setupLine, 'ArchitecturesInstallIn64BitMode is not set');
  // The Arm64 form (Privatica, PeepHole; Refreshify if its D-14 passes). SetupArchitecture stays x64: ISCC 7.1.1 takes only x86
  // and x64 there (measured: arm64 is "invalid", exit code 2), and the help says the x64 Setup runs on Arm64 Windows 11 by
  // emulation. ArchitecturesAllowed=arm64 is what keeps an x64 PC out: Setup ends with WindowsVersionNotSupported when the
  // expression does not match (Setup.MainFunc.pas lines 3622-3624 at tag is-7_1_1). With arm64 in the install mode only, an x64
  // PC runs the Setup (a 64-bit Setup's default ArchitecturesAllowed is x64compatible) in 32-bit install mode.
  else if (arm64Form(s)) {
    const out = nk.setup.get('outputbasefilename');
    if (!ARM64_RE.test(arch.value)) add('IC-2', arch.n, `ArchitecturesAllowed=arm64 with ArchitecturesInstallIn64BitMode=${arch.value}: the Arm64 form sets ArchitecturesInstallIn64BitMode=arm64 as well`);
    else if (!allowed || !ARM64_RE.test(allowed.value)) add('IC-2', allowed?.n ?? arch.n, `ArchitecturesInstallIn64BitMode=arm64 with ArchitecturesAllowed=${allowed?.value ?? '(not set: x64compatible in a 64-bit Setup)'}: an x64 PC runs this Setup in 32-bit install mode; the Arm64 form sets ArchitecturesAllowed=arm64 as well, so that an x64 PC cannot run it`);
    else if (!out || !/-\{#AppVersion\}-windows-arm64$/i.test(out.value)) add('IC-2', out?.n ?? setupLine, `the Arm64 form compiles D-A's Arm64 name, OutputBaseFilename={#AppName}-{#AppVersion}-windows-arm64, not ${out?.value ?? '(none)'}`);
  }
  // Any other value that names no x64 architecture (x86, arm64 with another identifier) gives 32-bit install mode on an x64 PC:
  // the app would land in Program Files (x86). The contract's value is x64compatible; x64os and the older x64 are the same
  // mode on x64.
  else if (!/\bx64(?:compatible|os)?\b/i.test(arch.value)) add('IC-2', arch.n, `ArchitecturesInstallIn64BitMode=${arch.value}: it must name x64compatible (or x64os), or be the Arm64 form, or an x64 PC gets 32-bit install mode`);
  const sa = set('SetupArchitecture');
  if (!sa || !/^x64$/i.test(sa.value)) add('IC-2', sa?.n ?? setupLine, 'SetupArchitecture=x64 is required: a 64-bit Setup and uninstaller (D-K, P-04)');
  const ul = set('UninstallLogging');
  if (!ul || !truthy(ul.value)) add('IC-3', ul?.n ?? setupLine, 'UninstallLogging=yes is required');
  const uw = set('UsedUserAreasWarning');
  if (uw && !truthy(uw.value)) add('IC-4', uw.n, 'UsedUserAreasWarning is switched off: the warning is an error, never silenced');

  // IC-5 ---------------------------------------------------------------
  const priv = set('PrivilegesRequired');
  const elevated = !priv || !/^lowest$/i.test(priv.value) || !!set('PrivilegesRequiredOverridesAllowed');
  if (elevated) {
    const hkcuRe = /\bHKCU(32|64)?\b|\bHKEY_CURRENT_USER\b/;
    for (const l of allLines) {
      const a = USER_AREA_RE.exec(l.text);
      const b = hkcuRe.exec(l.text);
      const c = USER_ENV_RE.exec(l.text);
      if (a) add('IC-5', l.n, `an elevated script names the per-user area ${a[0]}: per-user work belongs in the app ("Remove my data")`);
      else if (c) add('IC-5', l.n, `an elevated script reaches a per-user folder through ${c[0]}: per-user work belongs in the app ("Remove my data")`);
      else if (b) add('IC-5', l.n, `an elevated script uses ${b[0]}: it would reach the account that approved the prompt`);
    }
  }

  // IC-6 ---------------------------------------------------------------
  for (const sec of s.sections) {
    if (sec.name === 'run' || sec.name === 'code' || sec.name === '') continue;
    for (const r of sec.rows) {
      const t = r.text.trim();
      if (t === '' || t.startsWith(';') || t.startsWith('#')) continue;
      if (/\brunasoriginaluser\b/i.test(t)) add('IC-6', r.n, `runasoriginaluser in [${sec.name}]: it is valid in [Run] only`);
    }
  }
  if (s.hasCode) {
    for (const r of s.reach(UNINSTALL_EVENTS)) {
      const re = /(?<![A-Za-z_])(ExecAsOriginalUser|ShellExecAsOriginalUser)\s*\(/g;
      let m;
      while ((m = re.exec(r.text))) add('IC-6', s.lineAt(r.off + m.index), `${m[1]} reachable from an uninstall routine (${r.name}): it is not supported at uninstall time`);
    }
  }

  // IC-7 ---------------------------------------------------------------
  for (const l of textLines) {
    if (/\bcheck\s*:[^;]*\bWizardSilent\b/i.test(l.text)) add('IC-7', l.n, 'Check: WizardSilent: use the /UPDATE=1 switch (IsUpdate) instead');
  }

  // IC-8 ---------------------------------------------------------------
  // A bare name ("sc.exe"): any path, constant or variable in front of it makes the name not match the list.
  const toolOf = (v) => SYSTEM_TOOLS.includes(v.trim().replace(/\.exe$/i, '').toLowerCase());
  for (const l of allLines) {
    const m = /%(SystemRoot|windir|SystemDrive)%|\b[A-Za-z]:\\Windows\\/i.exec(l.text);
    if (m) add('IC-8', l.n, `${m[0]}: build System32 paths from {sys}; Exec and CreateProcess do not expand %...%`);
    const w = /\{(?:sysnative|syswow64)\}/i.exec(l.text);
    if (w) add('IC-8', l.n, `${w[0]}: build System32 paths from {sys}; the Setup is a 64-bit program (IC-2), so {sys} is the 64-bit folder and {sysnative} is not accessible to it`);
    // {win}\System32 names the same folder another way: the contract's one form is {sys}, and {win}\SysWOW64 and {win}\Sysnative
    // are not the 64-bit folder a 64-bit Setup means (measured: the check found nothing in {win}\System32\sc.exe before).
    const win = /\{win\}\\(?:System32|Sysnative|SysWOW64)\b/i.exec(l.text);
    if (win) add('IC-8', l.n, `${win[0]}: build System32 paths from {sys}, the one form of the contract`);
  }
  // A command line run through cmd.exe: `cmd /c sc.exe stop X` finds a bare tool by searching the current folder before PATH,
  // so a tool that cmd starts is named from {sys} too. Each command of the line (split at & && | ||) is read, and a first word
  // with no path, constant or variable in it that is on the checker's list is a bare tool.
  const isCmdExe = (file) => /(?:^|[\\{])cmd(?:\.exe)?\}?$/i.test(literalsOf(file).trim());
  const bareInCmdLine = (params) => {
    const after = /(?:^|\s)\/[ck]\s+([\s\S]*)$/i.exec(literalsOf(params));
    if (!after) return [];
    const bare = [];
    for (const part of after[1].split(/&&|\|\||[&|]/)) {
      const cmd = part.trim().replace(/^[("@\s]+/, '').replace(/^(?:start|call)\s+(?:\/\w+\s+)*/i, '').replace(/^["\s]+/, '');
      const word = /^[^\s"]+/.exec(cmd)?.[0];
      if (word && toolOf(word)) bare.push(word);
    }
    return bare;
  };
  for (const sec of ['run', 'uninstallrun']) {
    for (const e of s.entries(sec)) {
      if (e.p.filename && toolOf(e.p.filename)) add('IC-8', e.n, `[${sec}] runs "${e.p.filename}" without {sys}`);
      if (e.p.filename && isCmdExe(`'${e.p.filename.replace(/'/g, "''")}'`)) {
        for (const w of bareInCmdLine(`'${(e.p.parameters ?? '').replace(/'/g, "''")}'`)) add('IC-8', e.n, `[${sec}] runs "${w}" through cmd /c without {sys}: cmd.exe looks in the current folder before PATH`);
      }
    }
  }
  if (s.hasCode) {
    const re = /(?<![A-Za-z_])(?:Exec|ExecAsOriginalUser)\s*\(\s*'((?:[^']|'')*)'/g;
    let m;
    while ((m = re.exec(s.masked))) if (toolOf(m[1])) add('IC-8', s.lineAt(m.index), `Exec of "${m[1]}" without {sys}`);
    const re2 = /(?<![A-Za-z_])(ShellExec(?:AsOriginalUser)?)\s*\(\s*'(?:[^']|'')*'\s*,\s*'((?:[^']|'')*)'/g;
    while ((m = re2.exec(s.masked))) if (toolOf(m[2])) add('IC-8', s.lineAt(m.index), `${m[1]} of "${m[2]}" without {sys}`);
    // The same calls with cmd.exe as the program: the tool is the first word of the command line after /c or /k.
    const re3 = /(?<![A-Za-z_])(Exec|ExecAsOriginalUser|ShellExec|ShellExecAsOriginalUser)\s*\(/g;
    while ((m = re3.exec(s.masked))) {
      const args = callArgs(s.masked, m.index + m[0].length - 1);
      if (!args) continue;
      const shell = /^shellexec/i.test(m[1]);
      const file = args[shell ? 1 : 0];
      const params = args[shell ? 2 : 1];
      if (!file || !params || !isCmdExe(file.text)) continue;
      for (const w of bareInCmdLine(params.text)) add('IC-8', s.lineAt(m.index), `${m[1]} runs "${w}" through cmd /c without {sys}: cmd.exe looks in the current folder before PATH`);
    }
  }

  // IC-9, IC-10, IC-11, IC-21 -------------------------------------------
  const serviceRe = /\bbinPath\s*=|\bNew-Service\b|\bCreateService\b/i;
  if (!has('fixed-folder')) {
    for (const l of allLines) {
      if (serviceRe.test(l.text)) { add('IC-9', l.n, 'the script installs a service but the profile lacks fixed-folder (P-43)'); break; }
    }
  } else {
    const ddp = set('DisableDirPage');
    if (!ddp || !truthy(ddp.value)) add('IC-9', ddp?.n ?? setupLine, 'fixed-folder needs DisableDirPage=yes');
    const upd = set('UsePreviousAppDir');
    if (!upd || !/^(no|false|0)$/i.test(upd.value)) add('IC-9', upd?.n ?? setupLine, 'fixed-folder needs UsePreviousAppDir=no');
    if (priv && /^lowest$/i.test(priv.value)) add('IC-9', priv.n, 'fixed-folder is for an administrator install: PrivilegesRequired=admin');
    // With /CURRENTUSER (or the dialog) {autopf} is the per-user Programs folder, which the user can write: not a fixed folder.
    const ovr = set('PrivilegesRequiredOverridesAllowed');
    if (ovr && ovr.value !== '') add('IC-9', ovr.n, `PrivilegesRequiredOverridesAllowed=${ovr.value}: with an override {autopf} is the per-user Programs folder, so the folder is not fixed (P-43)`);
    const ddn = set('DefaultDirName');
    if (!ddn || !/^\{(autopf|autopf32|autopf64|commonpf|commonpf32|commonpf64|pf|pf32|pf64)\}/i.test(ddn.value)) {
      add('IC-9', ddn?.n ?? setupLine, 'fixed-folder needs DefaultDirName under Program Files ({autopf}\\Name)');
    }

    // Every implementation of PrepareToInstall runs (the main one and any with an event attribute), so the two calls may
    // stand in different ones.
    const preps = s.impls('PrepareToInstall');
    const prep = preps[0];
    const links = s.routine('InstallFolderLinksOk');
    const loc = s.routine('InstallFolderLocationOk');
    if (!prep) add('IC-10', s.hasCode ? s.codeStart : 1, 'no PrepareToInstall: fixed-folder refuses any other /DIR= there');
    else {
      if (!preps.some((r) => /\bInstallFolderLocationOk\s*\(\s*WizardDirValue\s*\)/.test(r.text))) add('IC-10', prep.line, 'PrepareToInstall does not call InstallFolderLocationOk(WizardDirValue)');
      if (!preps.some((r) => /\bInstallFolderLinksOk\s*\(\s*WizardDirValue\s*\)/.test(r.text))) add('IC-10', prep.line, 'PrepareToInstall does not call InstallFolderLinksOk(WizardDirValue) (the link-safe check of P-43)');
    }
    if (!loc) add('IC-10', 1, 'InstallFolderLocationOk is not defined');
    if (!links) add('IC-10', 1, 'InstallFolderLinksOk is not defined');
    else if (!(/GetFileAttributes|CreateFile|FindFirst|GetFileInformationByHandle/i.test(links.text) && /\$400|REPARSE/i.test(links.text))) {
      add('IC-10', links.line, 'InstallFolderLinksOk does not read each component\'s attributes and test for a reparse point ($400)');
    }

    if (!d23 || d23.text === '') add('IC-11', d23?.n ?? profileLine, 'no "; ic-d23-rights: ..." line naming where the rights-and-owner half of D23 runs');
    const lookups = s.routines.filter((r) => /_is1/.test(r.text) && !preps.includes(r));
    if (lookups.length === 0) add('IC-11', s.hasCode ? s.codeStart : 1, 'no lookup of an earlier installation from the _is1 uninstall key');
    for (const r of lookups) {
      if (!/\bHKLM32\b/.test(r.text) || !/\bHKLM64\b/.test(r.text)) add('IC-11', r.line, `${r.name} reads the _is1 key in one registry view only: use HKLM32 and HKLM64`);
      if (prep && !preps.some((p) => new RegExp(`\\b${r.name}\\b`).test(p.text))) add('IC-11', prep.line, `PrepareToInstall does not use ${r.name}`);
    }
  }
  // IC-21 reads every implementation of PrepareToInstall, the main one and any with an event attribute, and every routine they
  // call, as IC-6, IC-12 form B and IC-14 do. The Inno Setup 7.1.1 help (Abort): "Abort does not cause Setup or Uninstall to exit
  // unless it's called from one of these event functions (or another function invoked by them): InitializeSetup,
  // InitializeWizard, CurStepChanged(ssInstall), InitializeUninstall, CurUninstallStepChanged(usAppMutexCheck),
  // CurUninstallStepChanged(usUninstall)". PrepareToInstall is not on that list, so an Abort there, in the event or in a helper
  // it calls, lets Setup go on: the refusal fails open. Only a returned message stops Setup, with exit code 7.
  const prepAll = s.impls('PrepareToInstall');
  if (prepAll.length) {
    for (const pr of s.reach(['PrepareToInstall'])) {
      const own = prepAll.includes(pr);
      // Strings are blanked, so a message that says "Abort" is no call (offsets and lines stay the same).
      for (const ab of blankStrings(pr.text).matchAll(/(?<![A-Za-z_])(Abort|Halt|RaiseException|ExitProcess|TerminateProcess)\b/g)) {
        add('IC-21', s.lineAt(pr.off + ab.index), `${ab[1]} in ${pr.name}, ${own ? 'an implementation of PrepareToInstall' : 'a routine that PrepareToInstall calls'}: Abort does not stop Setup from PrepareToInstall (Inno Setup help: it exits only from InitializeSetup, InitializeWizard, CurStepChanged(ssInstall), InitializeUninstall and CurUninstallStepChanged(usAppMutexCheck, usUninstall)), so a refusal returns a non-empty string, which gives Setup exit code 7`);
      }
    }
    const asg = prepAll.flatMap((pr) => [...pr.text.matchAll(/\bResult\s*:=\s*([^;]+);/g)]).filter((m) => !/^''\s*$/.test(m[1].trim()));
    // The refusal message is the fixed folder's (IC-10): a PrepareToInstall of another profile may only detect and install a
    // prerequisite or shut an application down and return nothing ("detect and install missing prerequisites and/or to shutdown
    // any application", help, Event Functions). It is still read for an Abort above.
    if (has('fixed-folder') && asg.length === 0) add('IC-21', prepAll[0].line, 'PrepareToInstall never returns a refusal message (the fixed folder is refused there, IC-10)');
  }

  // IC-12 --------------------------------------------------------------
  for (const l of allLines) {
    if (/\bDeferRemovalWhenPackagesAreInUse\b/i.test(l.text)) add('IC-12', l.n, 'DeferRemovalWhenPackagesAreInUse is never used (CT-1)');
  }
  // [UninstallRun] is no undo. Inno Setup 7.1.1 runs InitializeUninstall, CurUninstallStepChanged(usAppMutexCheck) and
  // CurUninstallStepChanged(usUninstall) first, and only then the uninstall log's records, the [UninstallRun] ones first and the
  // newest install's first (Setup.Uninstall.pas lines 680, 698, 721 and 726 at tag is-7_1_1; Setup.UninstallLog.pas "Step 1",
  // line 775). So an [UninstallRun] entry runs after the last point where the uninstall can still abort, and the uninstaller
  // only logs its exit code (Step 1, lines 838 and 860): no profile may use one as its undo. A per-user app with no system change
  // (profile "none") has nothing to run there, and one that registers tasks (system-changes) undoes them in code.
  // The one exception is an update. Setup appends to the uninstall log of the install it updates (Inno Setup help, Appending
  // to Existing Uninstall Logs: UninstallLogMode "append, the default setting"), so an [UninstallRun] entry of the previous
  // release stays in that log and runs at the next uninstall, after this script's code, whatever this script says. The help's
  // one way to replace it is a new entry with the same RunOnceId: "only the latest entry with a RunOnceId setting of
  // 'DelService' will be executed" (compared case-sensitively). Such a superseding entry passes, and only with the previous
  // script (--previous) to prove the id. It replaces the inherited command; it is not the undo, which stays in code.
  const prevRuns = prevS?.entries('uninstallrun') ?? [];
  const inheritedIds = [...new Set(prevRuns.map((e) => e.p.runonceid).filter(Boolean))];
  for (const e of s.entries('uninstallrun')) {
    const id = e.p.runonceid;
    if (id && inheritedIds.includes(id)) continue;
    const base = '[UninstallRun] is no undo: it runs after CurUninstallStepChanged(usUninstall), the last point where the uninstall can abort, and the uninstaller only logs its exit code: undo in CurUninstallStepChanged(usUninstall) with Abort on failure.';
    let why;
    if (!id) why = 'This entry has no RunOnceId, so it supersedes nothing.';
    else if (!prevS) why = `The one exception is an entry that supersedes one inherited through the append-mode uninstall log, with the RunOnceId of an [UninstallRun] entry of the previous release's script: pass that script with --previous (RunOnceId "${id}" supersedes nothing here).`;
    else why = `RunOnceId "${id}" is not a RunOnceId of the previous script's [UninstallRun] (${inheritedIds.length ? inheritedIds.map((x) => `"${x}"`).join(', ') : prevRuns.length ? 'its [UninstallRun] entries have no RunOnceId' : 'it has no entry'}), so it supersedes nothing.`;
    add('IC-12', e.n, `${base} ${why}`);
  }
  if (!has('system-changes')) {
    // The profile is the app's own declaration; a script that registers a service, a task, a package or a shell entry
    // cannot leave it out and so switch the undo check off. With no profile line at all IC-0 already says so.
    const change = profile.length > 0 ? allLines.find((l) => SYSTEM_CHANGE_RE.test(l.text)) : undefined;
    if (change) {
      add('IC-12', change.n, `the script changes the system (${SYSTEM_CHANGE_RE.exec(change.text)[0]}) but the profile lacks system-changes: declare it, so the undo before the first file is removed is checked (P-44)`);
    } else if (profile.length > 0) {
      // A superseding entry replaces the previous release's undo command, so the app has a change to undo. That undo is code,
      // and the entry is not it: it runs after CurUninstallStepChanged(usUninstall) (closing round, Refreshify 3.0.0).
      const sup = s.entries('uninstallrun').find((e) => e.p.runonceid && inheritedIds.includes(e.p.runonceid));
      if (sup) {
        add('IC-12', sup.n, `the [UninstallRun] entry supersedes the previous release's entry "${sup.p.runonceid}", which undid a change of that release, but the profile lacks system-changes: the superseding entry is no undo (it runs after CurUninstallStepChanged(usUninstall)), so declare system-changes and undo in code`);
      }
    }
  } else {
    // Every implementation counts, the main routine and any with an event attribute (an include's, for example).
    const cus = s.impls('CurUninstallStepChanged');
    const ius = s.impls('InitializeUninstall');
    // Strings are blanked: the word Abort inside a message is no call (the two words are still read anywhere in the routine,
    // not as a shape: section 4 of the contract lists it).
    const formA = cus.some((r) => { const code = blankStrings(r.text); return /\busUninstall\b/.test(code) && /\bAbort\b/.test(code); });
    const formB = ius.some((r) => /\bResult\s*:=\s*False\b/i.test(r.text))
      && s.reach(['InitializeUninstall']).some((r) => /(?<![A-Za-z_])Exec\s*\(|\bRegDeleteKey|\bRegDeleteValue\b/.test(r.text));
    if (!formA && !formB) {
      add('IC-12', cus[0]?.line ?? ius[0]?.line ?? (s.hasCode ? s.codeStart : 1),
        'no undo of system changes before the first file is removed: CurUninstallStepChanged(usUninstall) with Abort on failure, or InitializeUninstall returning False');
    }
  }

  // IC-13 --------------------------------------------------------------
  const replaced = [];
  for (const e of s.entries('files')) {
    const flags = (e.p.flags ?? '').toLowerCase().split(/\s+/);
    const dest = e.p.destdir ?? '';
    const restart = flags.includes('restartreplace');
    // An installed file: its folder is not {tmp} and it is not dropped again or left alone (P-04, CT-1, D-34 (7)). ISCC 7.1.1
    // rejects an entry with no DestDir unless it is dontcopy ("Required parameter "DestDir" not specified", measured).
    const kept = !/^\{tmp\}/i.test(dest) && !flags.some((f) => NOT_KEPT_FLAGS.includes(f));
    if (!flags.includes('uninsrestartdelete')) {
      if (restart) add('IC-13', e.n, 'restartreplace without uninsrestartdelete');
      else if (kept) add('IC-13', e.n, `installed file without uninsrestartdelete: ${e.p.source ?? '(no source)'}`);
    }
    if (restart) {
      const nm = e.p.destname ?? (e.p.source ?? '').split(/[\\/]/).pop();
      if (nm && !/[*?]/.test(nm)) replaced.push(nm.toLowerCase());
    }
  }
  if (replaced.length) {
    for (const sec of ['run', 'uninstallrun']) {
      for (const e of s.entries(sec)) {
        // A postinstall entry is never processed when Setup has to restart (Inno Setup help, [Run] flags).
        if (sec === 'run' && /\bpostinstall\b/i.test(e.p.flags ?? '')) continue;
        const lc = e.text.toLowerCase();
        const hit = replaced.find((nm) => lc.includes(nm));
        if (hit) add('IC-13', e.n, `[${sec}] runs or registers ${hit}, which restartreplace may not have replaced yet`);
      }
    }
    if (s.hasCode) {
      const re = /(?<![A-Za-z_])(?:Exec|ExecAsOriginalUser|ShellExec|ShellExecAsOriginalUser)\s*\(([^;]*)\)\s*;/g;
      let m;
      while ((m = re.exec(s.masked))) {
        const lc = m[1].toLowerCase();
        const hit = replaced.find((nm) => lc.includes(nm));
        if (hit) add('IC-13', s.lineAt(m.index), `code runs or registers ${hit}, which restartreplace may not have replaced yet`);
      }
    }
  }

  // IC-14 --------------------------------------------------------------
  const iuAll = s.impls('InitializeUninstall');
  if (iuAll.length === 0) add('IC-14', s.hasCode ? s.codeStart : 1, 'no InitializeUninstall: it must refuse while a pending rename targets the install folder');
  else {
    const reached = s.reach(['InitializeUninstall']);
    if (!reached.some((r) => /PendingFileRenameOperations/.test(r.text))) {
      add('IC-14', iuAll[0].line, 'InitializeUninstall never reads PendingFileRenameOperations');
    } else if (!iuAll.some((r) => /\bResult\s*:=\s*False\b/i.test(r.text))) {
      add('IC-14', iuAll[0].line, 'InitializeUninstall never returns False');
    }
  }

  // IC-15 --------------------------------------------------------------
  for (const e of s.entries('installdelete')) {
    const nm = e.p.name ?? '';
    const type = (e.p.type ?? '').toLowerCase();
    if (/[*?]/.test(nm)) add('IC-15', e.n, `[InstallDelete] wildcard in "${nm}": list each file by name`);
    else if (/^\{app\}\\?$/i.test(nm) && type !== 'dirifempty') add('IC-15', e.n, '[InstallDelete] removes the whole install folder: list each file by name');
    else if (type === 'filesandordirs') add('IC-15', e.n, `[InstallDelete] Type: filesandordirs removes a whole tree (${nm}): list each file (Type: files) and each emptied folder (Type: dirifempty)`);
  }

  // IC-16 --------------------------------------------------------------
  for (const [k, v] of s.setup) {
    if (k === 'signedUninstaller'.toLowerCase()) { if (truthy(v.value)) add('IC-16', v.n, 'SignedUninstaller: nothing is code signed (PG-D18)'); }
    else if (/^sign/.test(k)) add('IC-16', v.n, `${k}: nothing is code signed (PG-D18)`);
  }
  for (const e of s.entries('files')) {
    if ((e.p.flags ?? '').toLowerCase().split(/\s+/).some((f) => ['sign', 'signonce', 'signcheck'].includes(f))) {
      add('IC-16', e.n, 'a sign flag on a [Files] entry: nothing is code signed (PG-D18)');
    }
  }

  // IC-17 --------------------------------------------------------------
  const runtimeHit = (text) => RUNTIME_PATTERNS.find((p) => p.test(text));
  for (const e of s.entries('files')) {
    const hit = runtimeHit(`${e.p.source ?? ''} ${e.p.destname ?? ''}`);
    if (hit) add('IC-17', e.n, `[Files] ships a runtime (${hit}): no .NET and no VC++ runtime ships`);
  }
  for (const sec of ['run', 'uninstallrun']) {
    for (const e of s.entries(sec)) {
      const url = /^https?:\/\//i.test(e.p.filename ?? '');
      // Opening a web page is how a missing runtime is shown. In an administrator Setup the page opens in the user's browser
      // with the user's rights: "runasoriginaluser" in [Run], ShellExecAsOriginalUser in code (PG-D8).
      if (url) {
        if (elevated && !/\brunasoriginaluser\b/i.test(e.p.flags ?? '')) add('IC-17', e.n, `[${sec}] opens ${e.p.filename} without runasoriginaluser: in an administrator Setup the browser would start with administrator rights (PG-D8)`);
        continue;
      }
      const hit = runtimeHit(`${e.p.filename ?? ''} ${e.p.parameters ?? ''}`);
      if (hit) add('IC-17', e.n, `[${sec}] runs a runtime installer (${hit})`);
    }
  }
  if (s.hasCode) {
    // Every string literal of [Code] is read: an extract, a download (DownloadTemporaryFile, CreateDownloadPage and
    // DownloadPage.Add take a URL or a file name), or a run of a runtime file all name it. Two literals are not that: a web
    // page that is the argument of ShellExec or ShellExecAsOriginalUser (the page shown to the user), and the name of a file
    // that only a presence test reads (FileExists and the like, the way a missing runtime is found).
    const flat = s.masked.replace(/'(?:[^'\n]|'')*'/g, (lit) => `'${'x'.repeat(lit.length - 2)}'`);
    const calls = (off) => {
      // The names of the calls that enclose a position, innermost first (strings are blanked, so their brackets do not count).
      const out = [];
      let depth = 0;
      for (let i = off - 1; i >= 0 && flat[i] !== ';'; i--) {
        if (flat[i] === ')') depth++;
        else if (flat[i] === '(') {
          if (depth > 0) depth--;
          else { const nm = /([A-Za-z_][\w.]*)\s*$/.exec(flat.slice(Math.max(0, i - 80), i)); if (nm) out.push(nm[1].split('.').pop().toLowerCase()); }
        }
      }
      return out;
    };
    for (const lm of s.masked.matchAll(/'((?:[^'\n]|'')*)'/g)) {
      const lit = lm[1];
      const enclosing = calls(lm.index);
      if (/^https?:\/\//i.test(lit) && /^shellexec(asoriginaluser)?$/.test(enclosing[0] ?? '')) {
        if (enclosing[0] === 'shellexec' && elevated) add('IC-17', s.lineAt(lm.index), `ShellExec opens ${lit} in an administrator Setup, so the browser starts with administrator rights: use ShellExecAsOriginalUser (PG-D8)`);
        continue;
      }
      // A presence test reads the name and nothing else. Looking up the enclosing calls from the inside, past the helpers that
      // only build a path, the first call must be a presence test, and no call above it may run, extract or download what it
      // returns: FileSearch returns the path of the file it found, so `Exec(FileSearch('vc_redist.x64.exe', Dir), ...)` runs it.
      const test = enclosing.findIndex((c) => !PATH_CALLS.includes(c));
      if (test >= 0 && DETECT_CALLS.includes(enclosing[test]) && !enclosing.slice(test + 1).some((c) => USE_CALLS.includes(c))) continue;
      const hit = runtimeHit(lit);
      if (hit) add('IC-17', s.lineAt(lm.index), `code names a runtime ("${lit}": ${hit}): it is extracted, downloaded or run here, and no .NET or VC++ runtime ships or runs from the installer`);
    }
    // A ShellExec in an administrator Setup whose target is a name, not a literal: the web page may be held in a constant or a
    // variable, and the browser would start with administrator rights (PG-D8). A constant the checker can read is judged by its
    // value; a name it cannot read (a variable, a parameter) is a finding too, because the target is not visible.
    if (elevated) {
      const consts = new Map();
      for (const sec of s.masked.matchAll(/\bconst\b([\s\S]*?)(?=\b(?:procedure|function|var|begin|type|const)\b|$)/gi)) {
        for (const c of sec[1].matchAll(/([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*'((?:[^'\n]|'')*)'\s*;/g)) consts.set(c[1].toLowerCase(), c[2].replace(/''/g, "'"));
      }
      const re = /(?<![A-Za-z_])ShellExec\s*\(/gi;
      let m;
      while ((m = re.exec(s.masked))) {
        const args = callArgs(s.masked, m.index + m[0].length - 1);
        const target = args?.[1]?.text.trim();
        if (!target || !/^[A-Za-z_]\w*$/.test(target)) continue;
        const value = consts.get(target.toLowerCase());
        if (value === undefined) add('IC-17', s.lineAt(m.index), `ShellExec in an administrator Setup opens ${target}, which the checker cannot read: open a web page with ShellExecAsOriginalUser and a literal address, or start a program with Exec (PG-D8)`);
        else if (/^https?:\/\//i.test(value)) add('IC-17', s.lineAt(m.index), `ShellExec opens ${value} (held in ${target}) in an administrator Setup, so the browser starts with administrator rights: use ShellExecAsOriginalUser (PG-D8)`);
      }
    }
  }

  // IC-18 --------------------------------------------------------------
  const filesSec = s.sections.find((x) => x.name === 'files');
  if (!s.entries('files').some((e) => /THIRD-PARTY-NOTICES/i.test(e.p.source ?? ''))) {
    add('IC-18', filesSec?.line ?? 1, '[Files] does not ship THIRD-PARTY-NOTICES');
  }
  for (const nf of input.notices ?? []) {
    const t = nf.text;
    // The Pascal Script licence asks for a visible line that the program is made using RemObjects Pascal Script and where it
    // can be found: the name and its address, in one place. The contract's sentence is the usual wording, but a different
    // sentence or a wrapped line holds the same two elements, so those are what is read (the name, then the address within
    // 200 characters of it).
    const pascalLine = /RemObjects\s+Pascal\s+Script[\s\S]{0,200}?https?:\/\/github\.com\/remobjects\/pascalscript/i;
    const need = [
      [pascalLine, 'the Pascal Script about-line: "RemObjects Pascal Script" with its address https://github.com/remobjects/pascalscript (the contract\'s wording: "Made using RemObjects Pascal Script (https://github.com/remobjects/pascalscript)")'],
      [/Copyright \(C\) 1997-\d{4} Jordan Russell/, 'the Inno Setup copyright notice "Copyright (C) 1997-YYYY Jordan Russell"'],
      [/Portions Copyright \(C\) 2000-\d{4} Martijn Laan/, 'the Inno Setup notice line "Portions Copyright (C) 2000-YYYY Martijn Laan" (license.txt: "the above copyright notice")'],
      [/jrsoftware\.org/, 'the Inno Setup web site address jrsoftware.org'],
    ];
    for (const [re, what] of need) if (!re.test(t)) add('IC-18', 1, `missing ${what}`, nf.name);
  }

  // IC-19 --------------------------------------------------------------
  if ((input.docs ?? []).length) {
    let found = 0;
    for (const df of input.docs) {
      df.text.replace(/\r\n?/g, '\n').split('\n').forEach((l, i) => {
        if (/unins\d{3}/i.test(l) && /\/(VERY)?SILENT/i.test(l)) {
          found++;
          if (!/\/NORESTART/i.test(l)) add('IC-19', i + 1, 'the silent uninstall command lacks /NORESTART', df.name);
        }
      });
    }
    if (found === 0) add('IC-19', 1, 'no silent uninstall command (unins000.exe /VERYSILENT ... /NORESTART) is documented', input.docs[0].name);
  }

  // IC-20 --------------------------------------------------------------
  if (has('aumid')) {
    for (const e of s.entries('icons')) {
      if (/\{uninstallexe\}/i.test(e.p.filename ?? '')) continue;
      if (!e.p.appusermodelid) add('IC-20', e.n, 'shortcut without AppUserModelID (P-29)');
    }
  }

  // IC-22 --------------------------------------------------------------
  if (prevS) {
    const p = prevS;
    const pid = p.setup.get('appid')?.value;
    const nid = set('AppId')?.value;
    if (!pid) add('IC-22', 1, 'the previous script has no AppId', 'previous');
    else if (!nid || nid.toLowerCase() !== pid.toLowerCase()) add('IC-22', set('AppId')?.n ?? setupLine, `AppId changed: was ${pid}, now ${nid ?? '(none)'}`);
    const pdir = p.setup.get('defaultdirname')?.value;
    const ndir = set('DefaultDirName')?.value;
    // The folder is compared as the folder it is: in a 64-bit administrator install {autopf}, {commonpf}, {commonpf64}, {pf} and
    // {pf64} are one folder (PermaDel's 3.0.0 names {commonpf64} where its 2.0.0 script says {autopf}), so each script's own
    // mode decides; with a lowest script, an override or no 64-bit mode the text is compared as written.
    // The same text is the same folder (the earlier rule); a different text is compared by the folder each script means.
    if (pdir && (!ndir || (ndir.toLowerCase() !== pdir.toLowerCase() && folderOf(p, pdir).toLowerCase() !== folderOf(s, ndir).toLowerCase()))) add('IC-22', set('DefaultDirName')?.n ?? setupLine, `install folder changed: was ${pdir}, now ${ndir ?? '(none)'}`);
    // The asset name stays (I-22; R1 5.2): the installed updaters look for it. It is the file name Setup is written under.
    // The two scripts are compared as PATTERNS, with `{#AppVersion}` left as a token on both sides: each script has its own
    // `#ifndef AppVersion` fallback (the real 2.x scripts say "2.0.0", the template "0.0.0"), and the build passes the real
    // version with --define=AppVersion=..., so what ISCC writes is `<App>-<that version>-Setup` for both (fix round 2).
    // An Arm64 script against a previous script that is not one (Refreshify's Arm64 installer if its D-14 passes) has no name
    // to keep: the installed updaters select the x64 asset, so its D-A name -windows-arm64 is a new asset (IC-2 checks it).
    const pk = parse(input.previous, ['AppVersion']);
    const pout = pk.setup.get('outputbasefilename')?.value;
    const nout = nk.setup.get('outputbasefilename')?.value;
    const newArm64Asset = arm64Form(s) && !arm64Form(p);
    if (pout && !newArm64Asset && (!nout || nout.toLowerCase() !== pout.toLowerCase())) {
      add('IC-22', nk.setup.get('outputbasefilename')?.n ?? setupLine, `asset name changed: OutputBaseFilename was ${pout}, now ${nout ?? '(none)'} (compared as a pattern, with {#AppVersion} kept as the token): the installed updaters select the release asset by that name`);
    }
    // Every exe name the previous script referenced, from everything that can name one: the file an [Files] entry installs
    // under {app} (its DestName, else the Source's own name), the Filename of [Run], [UninstallRun] and [Icons], and a
    // "{app}\X.exe" string in [Code]. The new script's whole text, [Code] included, must still name each of them.
    const exes = previousExeNames(p);
    for (const w of exes.notes) notes.push({ rule: 'IC-22', message: w });
    const newText = allLines.map((l) => l.text).join('\n');
    for (const [x, where] of exes.names) {
      if (!new RegExp(`(?<![\\w.-])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(newText)) {
        add('IC-22', setupLine, `exe name ${x} of the previous release is gone (the previous script names it in ${where})`);
      }
    }
  }

  // What the previous release left in the uninstall log (notes, never findings). Setup appends to that log (Inno Setup help,
  // Appending to Existing Uninstall Logs: "changes made by all the different installations will be undone"), so every entry of
  // the previous script that is stored in it still runs at the next uninstall of an install updated from that release: the
  // [UninstallRun] entries (stored in the log at install time, Installation Order), the [UninstallDelete] entries, and the
  // [Registry] uninsdeletekey and uninsdeletevalue records. A new script can replace an [UninstallRun] entry by its RunOnceId
  // (IC-12) and nothing else. The notes name each one so the reviewer sees what the new script inherits.
  if (prevS) {
    const own = new Set(s.entries('uninstallrun').map((e) => e.p.runonceid).filter(Boolean));
    for (const e of prevS.entries('uninstallrun')) {
      const id = e.p.runonceid;
      if (id && own.has(id)) continue;
      const cmd = [e.p.filename, e.p.parameters].filter(Boolean).join(' ');
      // An entry with no RunOnceId can never be superseded: RunOnceId is the one way to replace an inherited entry.
      const tail = id
        ? 'this script has no [UninstallRun] entry with that RunOnceId to supersede it'
        : 'an entry with no RunOnceId cannot be superseded by any script';
      notes.push({ rule: 'IC-12', message: `previous script line ${e.n}: [UninstallRun] ${cmd} (${id ? `RunOnceId "${id}"` : 'no RunOnceId'}) stays in the append-mode uninstall log of every install updated from that release and runs at the next uninstall, after this script's CurUninstallStepChanged(usUninstall) code; ${tail}, so the command must stay idempotent, must keep the user's data (P-05) and its switch name must not change (I-22's CLI contracts)` });
    }
    for (const e of prevS.entries('uninstalldelete')) {
      const name = e.p.name ?? '';
      if (!USER_AREA_RE.test(name) && !USER_ENV_RE.test(name)) continue;
      notes.push({ rule: 'IC-5', message: `previous script line ${e.n}: [UninstallDelete] ${e.p.type ?? ''} ${name} stays in the uninstall log of every install updated from that release, and the new uninstaller still runs it as the account that runs the uninstaller; RunOnceId is for [UninstallRun] only, so no script can replace it (IC-5 reads this script only)` });
    }
    for (const e of prevS.entries('registry')) {
      if (!/^HKCU/i.test(e.p.root ?? '') || !/\buninsdelete(?:keyifempty|key|value)\b/i.test(e.p.flags ?? '')) continue;
      notes.push({ rule: 'IC-5', message: `previous script line ${e.n}: [Registry] ${e.p.root} ${e.p.subkey ?? ''} with ${/\buninsdelete\w+/i.exec(e.p.flags)[0]} stays in the uninstall log of every install updated from that release, and the new uninstaller still deletes it in the hive of the account that runs the uninstaller; RunOnceId is for [UninstallRun] only, so no script can replace it (IC-5 reads this script only)` });
    }
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1) || a.rule.localeCompare(b.rule));
  return { findings, notes };
}

/**
 * A DefaultDirName as the folder it names (IC-22). In a 64-bit administrator install (no override, a 64-bit install mode) the
 * constants {autopf}, {autopf64}, {commonpf}, {commonpf64}, {pf} and {pf64} are the 64-bit Program Files folder, and {autopf32},
 * {commonpf32} and {pf32} the 32-bit one. In any other mode {autopf} depends on the account, so the text stays as written.
 * Only a constant at the start is read, and {pf64} and {pf32} are the canonical texts, so the others map onto them.
 */
function folderOf(script, dir) {
  const get = (k) => script.setup.get(k)?.value ?? '';
  const elevated = !/^lowest$/i.test(get('privilegesrequired')) && get('privilegesrequiredoverridesallowed') === '';
  // The Arm64 form installs in 64-bit mode too (IC-2), so its {autopf} is the native Program Files folder, as an x64 script's is.
  const mode = get('architecturesinstallin64bitmode');
  if (!elevated || !(/\bx64/i.test(mode) || ARM64_RE.test(mode))) return dir;
  return dir.replace(/^\{(?:autopf|autopf64|commonpf|commonpf64|pf)\}/i, '{pf64}').replace(/^\{(?:autopf32|commonpf32)\}/i, '{pf32}');
}

/** The findings of one script (see analyse for the notes that do not fail a run). */
export function checkInstaller(input) {
  return analyse(input).findings;
}

/**
 * The exe names that a previous script referenced (IC-22): a Map from the lower-case name to where the previous script names
 * it, and notes for what cannot be read from a script (a wildcard Source could install any exe).
 */
function previousExeNames(p) {
  const names = new Map();
  const notes = [];
  const note = (name, where) => { if (!names.has(name)) names.set(name, where); };
  const exeOf = (path) => {
    const base = path.split(/[\\/]/).pop().toLowerCase();
    return /^[^*?]+\.exe$/.test(base) ? base : null;
  };
  for (const e of p.entries('files')) {
    const flags = (e.p.flags ?? '').toLowerCase().split(/\s+/);
    const dest = e.p.destdir ?? '';
    if (!/^\{app\}(\\|$)/i.test(dest) || flags.some((f) => NOT_KEPT_FLAGS.includes(f))) continue;
    const src = e.p.source ?? '';
    const base = (e.p.destname ?? src).split(/[\\/]/).pop().toLowerCase();
    if (/[*?]/.test(base)) {
      // The pattern's extension decides whether it can match an exe at all (`*.dll` cannot; `*`, `*.*` and `*.exe` can).
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
      if (ext === '' || /[*?]/.test(ext) || ext === 'exe') {
        notes.push(`previous script line ${e.n}: [Files] Source "${src}" is a wildcard, so the exe names it installs cannot be read from the script: name each exe the updaters and the service registration need in [Run], [Icons] or [Code], or check the payload by hand`);
      }
      continue;
    }
    const x = exeOf(base);
    if (x) note(x, `[Files] line ${e.n}`);
  }
  for (const sec of ['run', 'uninstallrun', 'icons']) {
    for (const e of p.entries(sec)) {
      const fn = e.p.filename ?? '';
      if (!/^\{app\}\\/i.test(fn)) continue;
      const x = exeOf(fn);
      if (x) note(x, `[${{ run: 'Run', uninstallrun: 'UninstallRun', icons: 'Icons' }[sec]}] line ${e.n}`);
    }
  }
  if (p.hasCode) {
    for (const m of p.masked.matchAll(/\{app\}(?:\\[^'"\\;]+)*\\([^'"\\;]+\.exe)/gi)) note(m[1].toLowerCase(), `[Code] line ${p.lineAt(m.index)}`);
  }
  return { names, notes };
}

// ---------------------------------------------------------------- command line

function usageError(message) {
  process.stderr.write(`check-installer: ${message}\nusage: check-installer.mjs <app.iss> [--log F] [--notices F]... [--docs F]... [--previous F] [--include-dir D]... [--json]\n`);
  return 2;
}

/**
 * Read a text file as the text it is: UTF-8 (a BOM is dropped), or UTF-16 with a BOM, which is what Windows PowerShell 5.1
 * writes for `*> iscc.log`.
 */
function readText(path) {
  const b = readFileSync(path);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('utf8');
}

/**
 * Finds an include on the disk the way ISPP does (measured with ISCC 7.1.1): in the folder of the file that includes it, then in
 * the script's folder, then in each --include-dir. The key of a file is its full path, so two files with one name in two folders
 * stay two files; `shown` maps that key to the path as it is printed in a finding.
 */
function diskResolver(baseDir, dirs, shown) {
  const folderOf = new Map();
  return (name, from) => {
    const here = from === 'iss' ? baseDir : folderOf.get(from) ?? baseDir;
    for (const dir of [here, baseDir, ...dirs]) {
      const file = resolvePath(dir, name);
      let text;
      try { text = readText(file); } catch { continue; }
      folderOf.set(file, dirname(file));
      const rel = relative(process.cwd(), file);
      shown[file] = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
      return { key: file, text };
    }
    return undefined;
  };
}

export function main(argv) {
  let issPath = null;
  let logPath = null;
  let previousPath = null;
  let json = false;
  const noticePaths = [];
  const docPaths = [];
  const includeDirs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (['--log', '--notices', '--docs', '--previous', '--include-dir'].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return usageError(`${a} needs a file`);
      if (a === '--log') logPath = v;
      else if (a === '--notices') noticePaths.push(v);
      else if (a === '--docs') docPaths.push(v);
      else if (a === '--include-dir') includeDirs.push(v);
      else previousPath = v;
    } else if (a.startsWith('--')) return usageError(`unknown option ${a}`);
    else if (issPath === null) issPath = a;
    else return usageError('more than one script given');
  }
  if (issPath === null) return usageError('no script given');
  const readOrFail = (p) => {
    try { return readText(p); } catch (e) { throw new Error(`cannot read ${p}: ${e.code ?? e.message}`); }
  };
  let input;
  const includePaths = {};
  try {
    const iss = readOrFail(issPath);
    input = {
      iss,
      resolveInclude: diskResolver(dirname(issPath), includeDirs, includePaths),
      log: logPath ? readOrFail(logPath) : undefined,
      previous: previousPath ? readOrFail(previousPath) : undefined,
      notices: noticePaths.map((p) => ({ name: p, text: readOrFail(p) })),
      docs: docPaths.map((p) => ({ name: p, text: readOrFail(p) })),
    };
  } catch (e) {
    return usageError(e.message);
  }
  const { findings, notes } = analyse(input);
  // A note says what could not be read from the text; it never fails the run and goes to stderr, so stdout stays the findings.
  for (const n of notes) process.stderr.write(`check-installer: note ${n.rule}: ${n.message}\n`);
  const pathOf = (f) =>(f.file === 'iss' ? issPath : f.file === 'log' ? logPath : f.file === 'previous' ? previousPath : includePaths[f.file] ?? f.file);
  if (json) {
    process.stdout.write(JSON.stringify(findings.map((f) => ({ ...f, file: pathOf(f) })), null, 2) + '\n');
  } else {
    for (const f of findings) process.stdout.write(`${pathOf(f)}:${f.line}: ${f.rule} ${f.message}\n`);
    process.stdout.write(`check-installer: ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${basename(issPath)}\n`);
  }
  return findings.length ? 1 : 0;
}

// Real paths on both sides: Node gives import.meta.url as the module's real path, so a script path or working folder
// through a junction or symlink would not match the path as typed, and the command would exit 0 having checked nothing
// (B0-U02's inspector 8, N1; B0-U01 round 8).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolvePath(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
