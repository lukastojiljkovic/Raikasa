#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The notices generator (S-13; AbsolutelyFiles spec 5.13; engineering standard 3.10; PG-D3, PG-D4,
// PG-D10, PG-D36 (3), PG-D39). It writes THIRD-PARTY-NOTICES.md, and it fails on every notice
// problem a release could carry: a component with no licence, a notice text that no longer hashes
// to its pin, an obligation that nothing meets, a platform text that is not pinned. Nothing in this
// file is typed by hand in the notices: CI runs the generator and then
// `git diff --exit-code -- ':(glob)THIRD-PARTY-NOTICES*.md'` (the main file and every installer's file,
// whatever the repository writes), and `--check` compares in memory instead.
//
// Usage:
//   node generate-notices.mjs --write [inputs] [--installer <name>] [--out <file>]
//   node generate-notices.mjs --check [inputs] [--installer <name>] [--out <file>]
//
// Inputs. At least one of --cargo-about and --nuget-license is required; the rest have defaults.
//   --cargo-about <json>   the output of cargo-about 0.9.3 (ledger seq 13):
//        cargo about generate --format json --locked --fail --workspace --config about.toml --output-file notices/cargo-about.json
//        about.toml is generated from .github/licence-policy.json (licence-configs.mjs). It names the shipped
//        target (x86_64-pc-windows-gnullvm), ignores dev-dependencies and ignores our own crates through
//        [private] (they carry publish = false). Add --features, --all-features or --no-default-features
//        to match the shipped build, and --manifest-path when the workspace is not the working
//        folder. --format json needs no template. Every crate that appears in the report is a
//        third-party component: the generator reads each crate's source folder from the report's
//        manifest_path (Cargo's registry cache or git checkout; a relative path is resolved from the
//        report's folder) and sweeps it for notice files. A licence entry of the report with a null
//        source_path is not a text of the crate: cargo-about matched no licence file to the licence and
//        wrote the SPDX template, which names no copyright holder (measured with accesskit 0.24.0, whose
//        package holds no licence file, and with an eframe 0.37.0 app, where the template stands for
//        crates that do ship a licence file as well). A crate that only such an entry covers passes only
//        when its folder holds a LICENSE, LICENCE or COPYING file or the policy commits its text
//        (crate_texts, below); the template is still printed, with the authors of each crate that uses it.
//        Recorded limit: coverage is judged per crate, not per licence. A crate whose expression has an
//        AND (dpi 0.1.2: Apache-2.0 AND MIT) passes when a file covers one of its licences, even if
//        cargo-about wrote only the template for the other; the sweep prints every licence file of the
//        crate, so the text is in the notices when the crate ships it, but the generator does not match
//        a file to a licence id.
//        One call can take both reports (--cargo-about and --nuget-license): a repository that ships
//        Rust and .NET has one THIRD-PARTY-NOTICES.md, written by one job that has both reports.
//   --nuget-license <json> nuget-license 4.0.18 (ledger seq 21) output, for PerfWindow's sensor helper and
//        Refreshify 2.0.1 only (PG-D39). Run it on the shipped project only (`-i <shipped .csproj>`, not
//        the solution: a test project's packages are not shipped and would be listed as if they were),
//        always with the three files that the policy generates, so that a package which gives its
//        licence as a URL or a file is replaced by its clarification (the .NET 10 SDK must be on PATH or
//        in DOTNET_ROOT):
//        nuget-license -i <shipped .csproj> -t -o Json -fo <report.json>
//          -a .github/nuget-license/allowed-licenses.json
//          --override-package-information .github/nuget-license/overrides.json
//          --licensefile-to-license-mappings .github/nuget-license/licensefile-mappings.json
//        The licence job's run (`-i <solution>`, which check-licences.mjs judges) is a different run.
//        The report must be a non-empty list: an empty one, [], is an input error (exit 2), because a
//        repository passes --nuget-license only for a project that ships packages.
//        The generator reads PackageId, PackageVersion, PackageProjectUrl, Copyright, License and
//        LicenseInformationOrigin of each entry and ignores the rest. A package has a declared
//        licence only when the origin is 0 (an SPDX expression) or 4 (an override, which is the
//        policy's clarification) and License is an SPDX expression; origin 1 (a URL) and 5 (a file)
//        carry the URL or the file name in License and are refused. A package that fails -a is listed
//        with a ValidationErrors field, whose Context holds a path of the machine that ran the tool;
//        it never reaches the output. nuget-license's -d folder (licence texts downloaded from URLs) is
//        not read: those texts are not pinned.
//   --nuget-packages <dir> NuGet's global-packages folder, for example "$HOME/.nuget/packages"; required with
//        --nuget-license, and not allowed without it. Each package's <id lower case>/<version lower
//        case>/ folder is swept like a crate source (a folder that is not there is an input error).
//        The package's licence text is, first, its own LICENSE*, LICENCE* or COPYING* file; a
//        NOTICE* or THIRD-PARTY-NOTICES* file is written too but never counts as the licence text.
//        Second, the licence file of the package's clarification in the policy (ecosystem nuget;
//        licence_file.path is {path}/... for a file in the package folder, a path from the working
//        folder, or ~/...), whose SHA-256 is checked. Third, the policy's licence_texts entry for each
//        licence of the declared expression (see --policy), written once per licence with the
//        Copyright line of every package that uses it. A package with none of the three fails the run.
//   --inventory <json>     default notices/bundled-components.json, validated against
//   --schema <json>        default notices/bundled-components.schema.json. Each noticeTexts[].file (relative to
//        the inventory's folder) is the verbatim copy that the build's fetch step extracted from the
//        pinned source archive; the generator checks it against noticeTexts[].sha256 and writes it
//        as it is. The archive's own SHA-256 (archiveSha256) is checked by that fetch step, which has
//        the archive; this script never sees it.
//   --policy <json>        default .github/licence-policy.json: its platform entries (toolchain-runtime,
//        upstream-binary and separate-program) are written with their pinned licence text, after the
//        text's SHA-256 is checked against the entry's sha256 (null counts as not pinned). A
//        licence_file is a path from the working folder, or ~/. The policy's optional licence_texts
//        list pins the text of a licence that NuGet packages declare as an expression and do not
//        ship: { licence (an SPDX id, or an expression with WITH such as "Apache-2.0 WITH
//        LLVM-exception"), source, read, licence_file, sha256 }, each text committed under
//        .github/licence-texts/ exactly as its source publishes it (the copyright holder is not in it;
//        the generator writes the package's Copyright field beside it). An expression with AND or OR
//        needs a text for each licence in it. An upstream-binary entry is also
//        written with its upstream release, file and file_sha256, how it links Microsoft's runtime
//        and the conditions it passes on (templates/records/upstream-binary.schema.json: passes_on is
//        the upstream's own words as one string); a record that passes on an indemnity or further
//        terms (a passes_on_kind outside none and listed-restrictions) does not ship (PG-D36 (3)).
//        A platform entry may carry about_line, a non-empty string: the line that its licence asks
//        for in the notices (RemObjects Pascal Script's clause 3). It is written under Required
//        acknowledgements in every file, sorted and de-duplicated with the inventory's about lines.
//        The policy's optional crate_texts list commits the licence text of a crate whose package ships
//        none: { package, version, source, read, why, files: [{ path, sha256 }] }, the files stored where
//        the policy says (a path from the working folder, or ~/) exactly as their source publishes them
//        (the bytes of the git blob at the commit or tag in source, never a Windows working-tree copy,
//        whose line ends core.autocrlf may have changed). Crates of one repository that share their
//        texts are one entry: { crates: ["egui 0.37.0", "epaint 0.37.0"], source, read, why, files } in
//        place of package and version. Read only with --cargo-about; an entry that names a crate that the
//        report does not hold is not read, does not fail the run and is named in a note on stderr (a
//        per-installer report holds fewer crates than the policy names). Its optional source_links list,
//        { ecosystem (cargo or nuget), package, version, url (https) }, names the page that the Source
//        column gives for a package, such as its source at the exact release tag.
//   --installer <name>     x64 or arm64, in any case (the file name and the header use lower case). Write one
//        file per installer (S-13): keep the inventory
//        components whose ships[].architecture is <name> or "any", label those whose every
//        ships[].package is "installer" (and every separate-program entry) as shipping only in the
//        installer, and write THIRD-PARTY-NOTICES.<name>.md. Without it, every component is in one
//        file. The per-installer file is the copy that the program shows in About, so it carries the
//        assets.toml block of the main THIRD-PARTY-NOTICES.md (the folder of --out) when that file
//        has one: the asset-records check writes that one file, and --check on an installer's file
//        fails when its block no longer equals the main file's.
//   --out <file>           default THIRD-PARTY-NOTICES.md (THIRD-PARTY-NOTICES.<name>.md with --installer)
//   --app-name <name>      the program's name for the opening sentence (default "This program")
//
// Paths. A path that the policy or the inventory names may separate its folders with \ as well as /, as a
// file written on Windows may: the generator reads \ as / on every system, so the ubuntu runner reads the
// same file as Windows (Node's POSIX path functions would take crate-texts\x\LICENSE for one file name).
// The notices do not depend on the spelling, except the heading of a clarification's licence file, which
// gives the path as the policy writes it.
//
// Output. One Markdown file: sorted, stable headings, LF line ends, no timestamp and no path of this
// machine. Sections: required acknowledgements (an about-line obligation), the component table,
// the licence texts cargo-about reports, the verbatim NOTICE*, LICENSE*, LICENCE*, COPYING*,
// THIRD-PARTY-NOTICES* and ThirdPartyNotices* files of every shipped crate (case-insensitive, any
// folder; source files such as license.rs are left out; each file once by SHA-256 with the other
// places that hold it) and the texts the policy commits for crates whose package ships none (each
// with a line that says so), the NuGet table, the pinned licence texts of the NuGet packages that ship
// none (each once, with the copyright lines of the packages that use it) and their files, the
// components that are not crates, the platform components, and the block between the assets.toml
// markers, which belongs to the asset-records check and is kept as it stands. When no crate source
// holds such a file the section says "No crate source holds such a file."; a section of NuGet texts or
// files with nothing in it, and the platform section of a policy with no platform entry, are left out.
// A component is a level-3 heading and each contains[] level one deeper, down to ###### and no further
// (Markdown has six levels). A text keeps its
// bytes except that CRLF and a lone CR become LF and a leading byte-order mark is dropped; a file
// that is not UTF-8 is written as Latin-1 and says so in its heading. The SHA-256 beside a text is
// the hash of the file as committed or found, so it differs from a hash of the printed text when
// the file has CR line ends.
//
// --check runs every check of --write, regenerates in memory and compares with the file (a copy with
// CRLF line ends is a difference, and the message says that line ends are the only one). --write
// writes nothing when a check fails; it keeps the assets.toml block of an existing file whatever its
// line ends.
// Exit codes: 0 no problems; 1 problems (a failed check, a difference); 2 usage error, or an input
// that cannot be read (a report, the inventory, the schema, the policy, a crate's source folder).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

class InputError extends Error {}

const usage = (message) => {
  console.error(`generate-notices: ${message}`);
  process.exit(2);
};

let values;
try {
  ({ values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "cargo-about": { type: "string" },
      "nuget-license": { type: "string" },
      "nuget-packages": { type: "string" },
      inventory: { type: "string", default: "notices/bundled-components.json" },
      schema: { type: "string", default: "notices/bundled-components.schema.json" },
      policy: { type: "string", default: ".github/licence-policy.json" },
      installer: { type: "string" },
      out: { type: "string" },
      "app-name": { type: "string", default: "This program" },
    },
    allowPositionals: false,
  }));
} catch (e) {
  usage(e.message);
}
if (values.write === values.check) usage("exactly one of --write or --check is required");
if (!values["cargo-about"] && !values["nuget-license"]) usage("at least one of --cargo-about or --nuget-license is required");
// The architectures of the inventory's ships[] (notices/bundled-components.schema.json lists the same two
// and "any"): an installer is one of them, so a name such as x86_64 cannot silently drop every component.
const ARCHITECTURES = ["x64", "arm64"];
if (values.installer !== undefined && !ARCHITECTURES.includes(values.installer.toLowerCase())) usage(`--installer ${values.installer} is not one of ${ARCHITECTURES.join(", ")}`);
if (values["nuget-license"] && values["nuget-packages"] === undefined) usage('--nuget-license needs --nuget-packages (NuGet\'s global-packages folder, for example "$HOME/.nuget/packages"): the licence files of the packages are in it');
if (values["nuget-packages"] !== undefined && !values["nuget-license"]) usage("--nuget-packages is only for --nuget-license");
// The installer's name in lower case, whatever case it was given in: the file name and the header are
// the same for X64 and x64, because a Linux file system would take THIRD-PARTY-NOTICES.X64.md for another file.
const INSTALLER = values.installer?.toLowerCase();
const OUT = values.out ?? (INSTALLER ? `THIRD-PARTY-NOTICES.${INSTALLER}.md` : "THIRD-PARTY-NOTICES.md");

// ---- small helpers -----------------------------------------------------------------------

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readBytes = (path) => readFileSync(path);
const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InputError(`${what} ${path} could not be read: ${e.message}`);
  }
};
const cell = (s) => String(s ?? "").replace(/\r?\n/g, " ").replaceAll("|", "\\|");
const oneLine = (s) => String(s).trim().replace(/\s*[\r\n]+\s*/g, " ");
const hasValue = (s) => typeof s === "string" && s.trim() !== "";
const NO_LICENCE = new Set(["", "unknown", "none", "noassertion"]);
// Why a path named by the policy or the inventory cannot be read as a file, or null when it can. A folder
// at such a path would otherwise end the run with EISDIR and a stack trace instead of a named problem.
function unreadable(file) {
  if (file === null || !existsSync(file)) return "is not there";
  return statSync(file).isFile() ? null : "is not a file";
}

// The text of a file as the notices carry it: LF line ends (CRLF and a lone CR) and no byte-order
// mark (TextDecoder drops a leading UTF-8 one unless told to keep it). Bytes that are not UTF-8
// are read as Latin-1 and the caller marks the heading.
function decode(bytes) {
  let latin1 = false;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = bytes.toString("latin1");
    latin1 = true;
  }
  return { text: text.replace(/\r\n?/g, "\n"), latin1 };
}

// A fenced block that cannot be closed early by a fence inside the text.
function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

// ---- the sweep: notice and licence files in a source folder ---------------------------------

const NOTICE_NAME = /^(notice|license|licence|copying|third-party-notices|thirdpartynotices)/i;
// The files that are a licence text. A NOTICE or third-party notices file is carried too, but it
// is not the licence of the package that holds it, so it never makes a package "covered".
const LICENCE_NAME = /^(license|licence|copying)/i;
// Names that only look like a notice: source and binary files (license.rs), and the files NuGet keeps
// of a package, which are named after its id (licence.helper.nuspec, licence.helper.1.0.0.nupkg, its
// .nupkg.sha512 and .nupkg.metadata).
const SOURCE_EXT = new Set(["rs", "toml", "json", "lock", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "c", "h", "cc", "cpp", "cxx", "hpp", "hxx", "go", "java", "kt", "cs", "sh", "ps1", "bat", "yml", "yaml", "rb", "php", "swift", "lua", "pl", "s", "asm", "o", "a", "obj", "lib", "dll", "exe", "nuspec", "nupkg", "sha512", "metadata"]);

function sweep(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile() && NOTICE_NAME.test(entry.name)) {
        const ext = entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "";
        if (!SOURCE_EXT.has(ext)) found.push({ path: `${prefix}${entry.name}`, licence: LICENCE_NAME.test(entry.name), bytes: readBytes(join(dir, entry.name)) });
      }
    }
  };
  walk(root, "");
  return found;
}

// Each distinct file once, by SHA-256: the first holder in sorted order is the heading and the
// other holders are named under it. files: [{ owner: "name version", path, bytes }].
function verbatimSection(files) {
  const groups = new Map();
  for (const f of files) {
    const sha = sha256(f.bytes);
    if (!groups.has(sha)) groups.set(sha, []);
    // the same file reached twice (swept, and named by a clarification) is one holder
    if (!groups.get(sha).some((g) => g.owner === f.owner && g.path === f.path)) groups.get(sha).push(f);
  }
  const sorted = [...groups.entries()]
    .map(([sha, list]) => [sha, list.sort((a, b) => cmp(`${a.owner}\0${a.path}`, `${b.owner}\0${b.path}`))])
    .sort((a, b) => cmp(`${a[1][0].owner}\0${a[1][0].path}\0${a[0]}`, `${b[1][0].owner}\0${b[1][0].path}\0${b[0]}`));
  let out = "";
  for (const [sha, list] of sorted) {
    const { text, latin1 } = decode(list[0].bytes);
    out += `### ${list[0].owner} — ${list[0].path}${latin1 ? " (read as Latin-1)" : ""}\n\n`;
    out += `- SHA-256 of the file: \`${sha}\`\n`;
    if (list.length > 1) out += `- Identical file in: ${list.slice(1).map((f) => `${f.owner} — ${f.path}`).join("; ")}\n`;
    // a file that is not part of the package (a text the policy commits) says where it came from
    for (const f of list) if (f.note) out += `- ${f.owner} — ${f.path}: ${f.note}\n`;
    out += `\n${fenced(text)}\n`;
  }
  return out;
}

// ---- the inventory schema (a small validator for the keywords the schema uses) ----------------

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "$defs", "title", "description"]);
const KEYWORDS = new Set(["type", "required", "additionalProperties", "properties", "$ref", "items", "enum", "const", "pattern", "minLength", "minItems", "oneOf", "uniqueItems"]);
const child = (path, key) => (path ? `${path}.${key}` : key);
const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function validate(schema, value, path, root, errors) {
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !KEYWORDS.has(key)) throw new InputError(`the schema uses the keyword ${key}, which this generator does not understand`);
  }
  if (schema.$ref !== undefined) {
    const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(schema.$ref);
    const target = m && Object.hasOwn(root.$defs ?? {}, m[1]) ? root.$defs[m[1]] : undefined;
    if (!target) throw new InputError(`the schema refers to ${schema.$ref}, which is not in $defs`);
    validate(target, value, path, root, errors);
  }
  if (schema.type !== undefined) {
    const k = kind(value);
    const ok = schema.type === "integer" ? Number.isInteger(value) : schema.type === k;
    if (!ok) {
      errors.push(`${path || "the inventory"} must be ${schema.type === "array" || schema.type === "object" ? `an ${schema.type}` : `a ${schema.type}`}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(schema.minLength === 1 ? `${path} must not be empty` : `${path} must be at least ${schema.minLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path} "${value}" does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} must hold at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path} has a duplicate entry`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, root, errors));
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((s) => {
      const scratch = [];
      validate(s, value, path, root, scratch);
      return scratch.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${path} must match exactly one of the allowed shapes`);
  }
  if (kind(value) === "object") {
    // Object.hasOwn, not `in`: a field named constructor or toString is on every object's prototype.
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${child(path, key)} is required`);
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) validate(props[key], v, child(path, key), root, errors);
      else if (schema.additionalProperties === false) errors.push(`${child(path, key)} is not a field of the schema`);
    }
  }
}

// ---- reading the inputs and judging them ----------------------------------------------------

const LINKAGES = ["static", "import", "none"];
const PASSES_ON_KINDS = ["none", "listed-restrictions"];
const problems = [];
const problem = (message) => problems.push(message);
// A note is written to stderr and changes neither the exit code nor the file.
const notes = [];

// The policy's crate_texts (read with a cargo-about report only): the licence text of a crate whose package
// ships none, committed in the repository (AccessKit's and egui's packages hold no LICENSE, LICENCE or
// COPYING file, and cargo-about then writes its SPDX template, which names no copyright holder). One entry
// names one crate and version ({ package, version }) or several that one repository gives the same
// texts ({ crates: ["name version", ...] }, such as the seven egui crates), so that a version bump edits a
// list and not an entry per crate. The rest of an entry: { source (where the files were taken from), read,
// why, files: [{ path (from the working folder, or ~/), sha256 (null until pinned) }] }. A cargo
// clarification cannot do this: its path is read inside the crate by cargo-about and cargo-deny.
const CRATE_KEY = /^\S+\s+\S+$/;
// The "name version" keys that an entry names, or null when it names none in a form this reads.
function namedCrates(e) {
  if (e === null || typeof e !== "object") return null;
  if (Object.hasOwn(e, "crates")) {
    const ok = !Object.hasOwn(e, "package") && !Object.hasOwn(e, "version") && Array.isArray(e.crates) && e.crates.length > 0 && e.crates.every((c) => typeof c === "string" && CRATE_KEY.test(c.trim()));
    return ok ? e.crates.map((c) => c.trim().replace(/\s+/, " ")) : null;
  }
  return hasValue(e.package) && hasValue(e.version) ? [`${e.package.trim()} ${e.version.trim()}`] : null;
}

function readCrateTexts(policy) {
  const entries = new Map();
  const list = policy.crate_texts ?? [];
  if (!Array.isArray(list)) {
    problem("the policy: crate_texts must be a list");
    return entries;
  }
  list.forEach((e, i) => {
    const files = e !== null && typeof e === "object" ? e.files : undefined;
    const filesOk = Array.isArray(files) && files.length > 0 && files.every((f) => f !== null && typeof f === "object" && hasValue(f.path) && Object.hasOwn(f, "sha256") && (f.sha256 === null || /^[0-9a-f]{64}$/.test(f.sha256)));
    const keys = namedCrates(e);
    if (keys === null || !filesOk) {
      problem(`crate_texts[${i}]: a committed crate text needs package, version and files (a non-empty list of { path, sha256 }); several crates of one repository are given as crates, a list of "name version", in place of package and version`);
      return;
    }
    for (const key of keys) {
      if (entries.has(key)) problem(`crate_texts[${i}]: ${key} is listed twice`);
      else entries.set(key, { source: hasValue(e.source) ? e.source.trim() : null, files });
    }
  });
  return entries;
}

// The committed files of one crate, each read and hash-checked: [{ owner, path, bytes, note }].
function crateTextFiles(key, entry) {
  const found = [];
  for (const f of entry.files) {
    const file = policyFile(f.path);
    const why = unreadable(file);
    if (why) problem(`${key}: committed licence text ${f.path} ${why}`);
    else if (f.sha256 === null) problem(`${key}: committed licence text ${f.path} is not pinned yet (sha256 null); pin its SHA-256 in crate_texts`);
    else {
      const bytes = readBytes(file);
      const actual = sha256(bytes);
      if (actual !== f.sha256) problem(`${key}: committed licence text ${f.path} has SHA-256 ${actual}, not the pinned ${f.sha256}`);
      else found.push({ owner: key, path: f.path.split(/[\\/]/).pop(), bytes, note: `committed text, not in the crate's package (${entry.source ? `from ${entry.source}; ` : ""}pinned in .github/licence-policy.json, crate_texts)` });
    }
  }
  return found;
}

// cargo-about: crates, their declared licences, the licence texts the tool found, and each
// crate's source folder swept for notice files. A licence entry with no source_path is not a text of
// the crate: cargo-about wrote the SPDX template ("Copyright (c) <year> <copyright holders>") because
// it found no licence file. Such a crate has a licence text only if its folder holds a LICENSE,
// LICENCE or COPYING file, or the policy commits one (crate_texts).
function readCargo(path, crateTexts) {
  const report = readJson(path, "the cargo-about report");
  if (!Array.isArray(report?.crates) || !Array.isArray(report?.licenses)) throw new InputError(`the cargo-about report ${path} is not cargo-about's JSON output (cargo about generate --format json)`);
  if (report.crates.length === 0) throw new InputError(`the cargo-about report ${path} lists no crate: cargo about did not run, or the graph is empty`);
  const reportDir = dirname(resolve(path));
  const byKey = new Map();
  for (const c of report.crates) {
    const p = c.package ?? {};
    if (!hasValue(p.name) || !hasValue(p.version)) throw new InputError(`the cargo-about report ${path} is not cargo-about's JSON output: a crate has no name or version`);
    byKey.set(`${p.name} ${p.version}`, {
      name: p.name,
      version: p.version,
      licence: c.license ?? p.license ?? "",
      repository: p.repository ?? null,
      source: p.source ?? null,
      authors: Array.isArray(p.authors) ? p.authors.map((a) => String(a).trim()).filter(Boolean) : [],
      dir: dirname(resolve(reportDir, p.manifest_path ?? "")),
      hasManifest: hasValue(p.manifest_path),
    });
  }
  const crates = [...byKey.values()].sort((a, b) => cmp(`${a.name}\0${a.version}`, `${b.name}\0${b.version}`));
  const texts = new Map();
  const own = new Set(); // crates that a text cargo-about read from a file covers
  const templated = new Set(); // crates that only cargo-about's SPDX template covers
  for (const l of report.licenses) {
    const sha = sha256(l.text ?? "");
    const fromFile = hasValue(l.source_path);
    if (!texts.has(sha)) texts.set(sha, { id: l.id ?? "", name: l.name ?? "", text: l.text ?? "", users: new Map() });
    const group = texts.get(sha);
    for (const u of l.used_by ?? []) {
      const key = `${u.crate?.name} ${u.crate?.version}`;
      group.users.set(key, (group.users.get(key) ?? false) || !fromFile); // key -> the text is the template
      (fromFile ? own : templated).add(key);
    }
  }
  const files = [];
  for (const c of crates) {
    const key = `${c.name} ${c.version}`;
    if (NO_LICENCE.has(String(c.licence).trim().toLowerCase())) problem(`${key}: no declared licence (cargo-about reports "${c.licence || "Unknown"}"); clarify it in .github/licence-policy.json, replace the crate or drop it`);
    if (!c.hasManifest) throw new InputError(`${key}: the cargo-about report gives no manifest_path for this crate, so its source folder is unknown`);
    if (!existsSync(c.dir)) throw new InputError(`${key}: the crate source folder ${c.dir} is not there (fetch the crates with cargo, or point manifest_path at the registry cache)`);
    const swept = sweep(c.dir);
    for (const f of swept) files.push({ owner: key, path: f.path, bytes: f.bytes });
    const committed = crateTexts.get(key);
    if (committed) files.push(...crateTextFiles(key, committed)); // a committed text that fails is reported there, once
    // A NOTICE or third-party notices file alone is not the crate's licence text, and neither is the template.
    if (!own.has(key) && !swept.some((f) => f.licence) && !committed) {
      problem(
        templated.has(key)
          ? `${key}: ships no licence file; cargo-about wrote the SPDX template, which names no copyright holder; commit the crate's licence text and list it under crate_texts in .github/licence-policy.json`
          : `${key}: no licence text: cargo-about found none and the crate source holds no LICENSE, LICENCE or COPYING file`,
      );
    }
  }
  // An entry that names a crate this report does not hold is not read and does not fail the run: a per-installer
  // report holds fewer crates than the policy names, and a version that moved on leaves its entry behind.
  const spent = [...crateTexts.keys()].filter((k) => !byKey.has(k)).sort(cmp);
  if (spent.length) notes.push(`crate_texts names ${spent.length === 1 ? "a crate" : "crates"} that this report does not hold, and nothing was read for ${spent.length === 1 ? "it" : "them"}: ${spent.join(", ")}; remove an entry that no report of this repository needs any more`);
  return { crates, texts, files };
}

// ---- the policy: platform entries, pinned licence texts and NuGet clarifications ----------------

function readPolicy(path) {
  const policy = readJson(path, "the policy");
  if (policy === null || typeof policy !== "object" || !Array.isArray(policy.platform)) throw new InputError(`the policy ${path} has no platform list`);
  return policy;
}

// The policy's source_links: the page that the Source column names for a package, where the project's
// own URL is not the place that a licence points to (an MPL-2.0 component is met with a link to its
// source at the exact release tag). { ecosystem (cargo or nuget), package, version, url (https) }.
function readSourceLinks(policy) {
  const links = new Map();
  const list = policy.source_links ?? [];
  if (!Array.isArray(list)) {
    problem("the policy: source_links must be a list");
    return links;
  }
  list.forEach((e, i) => {
    if (!["cargo", "nuget"].includes(e?.ecosystem) || !hasValue(e.package) || !hasValue(e.version) || !hasValue(e.url) || !/^https:\/\/\S+$/.test(e.url.trim())) {
      problem(`source_links[${i}]: needs ecosystem (cargo or nuget), package, version and an https URL`);
      return;
    }
    links.set(`${e.ecosystem}\0${e.package.trim().toLowerCase()}\0${e.version.trim()}`, e.url.trim());
  });
  return links;
}

// A licence file named in the policy: a path from the working folder, ~/ for the home folder, or {path}/
// for a file in the package folder (a NuGet clarification; null when there is no package folder). A \ is
// read as /: a policy written on Windows then names the same file on the ubuntu runner, where Node's POSIX
// path functions take crate-texts\x\LICENSE for one file name in the working folder.
function policyFile(spec, packageDir) {
  spec = spec.replaceAll("\\", "/");
  if (spec.startsWith("{path}")) return packageDir === undefined ? null : join(packageDir, spec.slice("{path}".length).replace(/^[\\/]+/, ""));
  if (spec.startsWith("~/")) return `${homedir()}${spec.slice(1)}`;
  return resolve(spec);
}

// The text of a licence that packages declare as an expression and do not ship (licence_texts of the
// policy): one pin per licence, each read and hash-checked once, when a package needs it.
function readLicenceTexts(policy) {
  const pins = new Map();
  const list = policy.licence_texts ?? [];
  if (!Array.isArray(list)) {
    problem("the policy: licence_texts must be a list");
    return pins;
  }
  list.forEach((e, i) => {
    const where = `licence_texts[${i}]`;
    const pinnedOrNull = e !== null && typeof e === "object" && Object.hasOwn(e, "sha256") && (e.sha256 === null || /^[0-9a-f]{64}$/.test(e.sha256));
    if (!hasValue(e?.licence) || !hasValue(e.licence_file) || !pinnedOrNull) {
      problem(`${where}: a pinned licence text needs licence, licence_file and sha256 (a SHA-256, or null until pinned)`);
      return;
    }
    const id = e.licence.trim().toLowerCase();
    if (pins.has(id)) {
      problem(`${where}: ${e.licence} is pinned twice`);
      return;
    }
    pins.set(id, { licence: e.licence.trim(), file: e.licence_file, sha256: e.sha256, state: "unread", bytes: null });
  });
  return pins;
}

// The bytes of a pinned text once its hash is right; otherwise null, with the problem reported once.
function loadPin(pin) {
  if (pin.state === "unread") {
    pin.state = "read";
    const why = unreadable(policyFile(pin.file));
    if (why) problem(`${pin.licence}: licence text ${pin.file} ${why}`);
    else if (pin.sha256 === null) problem(`${pin.licence}: licence text ${pin.file} is not pinned yet (sha256 null); pin its SHA-256 in the policy (PG-D3)`);
    else {
      const bytes = readBytes(policyFile(pin.file));
      const actual = sha256(bytes);
      if (actual !== pin.sha256) problem(`${pin.licence}: licence text ${pin.file} has SHA-256 ${actual}, not the pinned ${pin.sha256}`);
      else pin.bytes = bytes;
    }
  }
  return pin.bytes;
}

// The licences of an SPDX expression that need a text each: the whole expression when the policy pins it
// as written, otherwise its terms joined by AND or OR (a term with WITH, such as
// "Apache-2.0 WITH LLVM-exception", is one term).
const licenceUnits = (expression) => [...new Set(expression.split(/[()]|\s+(?:AND|OR)\s+/i).map((u) => u.trim()).filter(Boolean))];

// nuget-license prints LicenseInformationOrigin as a number: 0 an SPDX expression, 1 a URL, 2 nothing,
// 3 an ignored package, 4 an override (the policy's clarification), 5 a file (measured with 4.0.18).
const ORIGINS = { 0: "an SPDX expression", 1: "a URL", 2: "nothing", 3: "an ignored package", 4: "an override", 5: "a file" };
const EXPRESSION_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*(:[A-Za-z0-9.+-]+)?$/;
const FILE_NAME = /\.(txt|md|rtf|html?|pdf)$/i;
const OPERATOR = /^(AND|OR|WITH)$/i;

// A small parser for an SPDX licence expression: id [WITH id] and AND, OR and parentheses. A file name
// or a URL is not one, whatever its origin says.
function isSpdxExpression(text) {
  if (!hasValue(text)) return false;
  const tokens = text.match(/[()]|[^\s()]+/g);
  let i = 0;
  const id = () => {
    const t = tokens[i];
    if (t === undefined || !EXPRESSION_ID.test(t) || FILE_NAME.test(t) || OPERATOR.test(t)) return false;
    i += 1;
    return true;
  };
  const term = () => {
    if (tokens[i] === "(") {
      i += 1;
      if (!expression() || tokens[i] !== ")") return false;
      i += 1;
      return true;
    }
    if (!id()) return false;
    if (/^WITH$/i.test(tokens[i] ?? "")) {
      i += 1;
      return id();
    }
    return true;
  };
  const expression = () => {
    if (!term()) return false;
    while (/^(AND|OR)$/i.test(tokens[i] ?? "")) {
      i += 1;
      if (!term()) return false;
    }
    return true;
  };
  return expression() && i === tokens.length;
}

// What nuget-license reported for a package whose licence is not a declared SPDX expression.
function undeclared(origin, reported) {
  if (!hasValue(reported) || origin === 2) return "nuget-license reports nothing";
  if (origin === 0 || origin === 4) return `nuget-license reports "${oneLine(reported)}" as the licence, which is not an SPDX expression`;
  return `nuget-license reports ${ORIGINS[origin] ?? `an unknown origin (${origin})`} (${oneLine(reported)}), not an SPDX expression`;
}

// A clarification's licence file, hash-checked: { path, bytes } to write, or null with the problem reported.
function clarificationText(c, key, packageDir) {
  const spec = c.licence_file?.path;
  const pinned = c.licence_file?.sha256;
  if (!hasValue(spec) || typeof pinned !== "string") {
    problem(`${key}: its clarification has no licence_file { path, sha256 }`);
    return null;
  }
  const file = policyFile(spec, packageDir);
  const why = unreadable(file);
  if (why) {
    problem(`${key}: the clarification's licence file ${spec} ${why}`);
    return null;
  }
  const bytes = readBytes(file);
  const actual = sha256(bytes);
  if (actual !== pinned) {
    problem(`${key}: the clarification's licence file ${spec} has SHA-256 ${actual}, not the pinned ${pinned}`);
    return null;
  }
  return { path: spec.startsWith("{path}") ? spec.slice("{path}".length).replace(/^[\\/]+/, "") : spec, bytes };
}

// nuget-license: the packages with their declared licences and each package's licence text, from
// its own files, its clarification or the policy's pinned text for its licence (in that order).
function readNuget(path, packagesDir, policy, pins) {
  const report = readJson(path, "the nuget-license report");
  if (!Array.isArray(report) || report.length === 0 || report.some((p) => !p || !hasValue(p.PackageId) || !hasValue(p.PackageVersion) || !Number.isInteger(p.LicenseInformationOrigin))) {
    throw new InputError(`the nuget-license report ${path} is not nuget-license's JSON output (nuget-license -o Json): a non-empty list of packages with PackageId, PackageVersion and LicenseInformationOrigin`);
  }
  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) throw new InputError(`--nuget-packages ${packagesDir} is not a folder`);
  // A package that nuget-license lists twice (two projects of the solution) is one entry.
  const entries = new Map();
  for (const p of report) entries.set(`${p.PackageId} ${p.PackageVersion}`, p);
  const sorted = [...entries.values()].sort((a, b) => cmp(`${a.PackageId}\0${a.PackageVersion}`, `${b.PackageId}\0${b.PackageVersion}`));
  const clarifications = Array.isArray(policy.clarifications) ? policy.clarifications : [];
  const packages = [];
  const files = [];
  const groups = new Map();
  for (const p of sorted) {
    const key = `${p.PackageId} ${p.PackageVersion}`;
    const origin = p.LicenseInformationOrigin;
    const reported = typeof p.License === "string" ? p.License.trim() : "";
    const clarification = clarifications.find((c) => c?.ecosystem === "nuget" && typeof c.package === "string" && c.package.toLowerCase() === p.PackageId.toLowerCase() && c.version === p.PackageVersion);
    const declared = (origin === 0 || origin === 4) && isSpdxExpression(reported);
    packages.push({ name: p.PackageId, version: p.PackageVersion, licence: declared ? reported : "", url: p.PackageProjectUrl ?? null });
    if (!declared) {
      const seen = undeclared(origin, reported);
      const fix = clarification
        ? "the policy clarifies it, so run nuget-license with --override-package-information .github/nuget-license/overrides.json"
        : "add a clarification for it to .github/licence-policy.json (ecosystem nuget) and run nuget-license with --override-package-information .github/nuget-license/overrides.json";
      problem(`${key}: no declared licence: ${seen}; ${fix}`);
      continue;
    }
    const dir = join(packagesDir, p.PackageId.toLowerCase(), p.PackageVersion.toLowerCase());
    if (!existsSync(dir)) throw new InputError(`${key}: the package folder ${dir} is not there (restore the project, or point --nuget-packages at NuGet's global-packages folder)`);
    const swept = sweep(dir);
    for (const f of swept) files.push({ owner: key, path: f.path, bytes: f.bytes });
    // A NOTICE or third-party notices file is carried, but it is not the licence text.
    let covered = swept.some((f) => f.licence);
    if (clarification) {
      const text = clarificationText(clarification, key, dir);
      if (text) files.push({ owner: key, path: text.path, bytes: text.bytes });
      covered = true; // a clarification that fails is reported above, once
    }
    if (covered) continue;
    const wanted = pins.has(reported.toLowerCase()) ? [reported] : licenceUnits(reported);
    const missing = wanted.filter((u) => !pins.has(u.toLowerCase()));
    if (missing.length) {
      problem(`${key}: no licence text: it declares ${reported}, its folder holds no LICENSE, LICENCE or COPYING file and the policy pins no text for ${missing.join(", ")}`);
      continue;
    }
    const copyright = hasValue(p.Copyright) ? oneLine(p.Copyright) : "no copyright line in the package's metadata";
    for (const unit of wanted) {
      const pin = pins.get(unit.toLowerCase());
      const bytes = loadPin(pin);
      if (bytes === null) continue;
      const sha = sha256(bytes);
      // one text per licence (a licence is pinned once, so one hash); its users arrive in package order
      if (!groups.has(pin.licence)) groups.set(pin.licence, { licence: pin.licence, sha, bytes, users: [] });
      groups.get(pin.licence).users.push(`${key}: ${copyright}`);
    }
  }
  const pinned = [...groups.values()].sort((a, b) => cmp(a.licence, b.licence));
  return { packages, files, pinned };
}

// The inventory: schema first, then the checks the schema cannot make.
function readInventory(path, schemaPath) {
  const inventory = readJson(path, "the inventory");
  const schema = readJson(schemaPath, "the inventory schema");
  const errors = [];
  validate(schema, inventory, "", schema, errors);
  for (const e of errors) problem(`the inventory ${path}: ${e}`);
  if (errors.length) return [];
  const base = dirname(resolve(path));
  const ids = new Set();
  const visit = (list, fn) => {
    for (const c of list) {
      fn(c);
      visit(c.contains ?? [], fn);
    }
  };
  visit(inventory.components, (c) => {
    if (ids.has(c.id)) problem(`the id ${c.id} is used twice in the inventory`);
    ids.add(c.id);
    if (!isSpdxExpression(c.licence)) problem(`${c.id}: licence "${c.licence}" is not an SPDX expression`);
    c.noticeTexts.forEach((t, i) => {
      t.file = t.file.replaceAll("\\", "/"); // as in policyFile: an inventory written on Windows reads the same on ubuntu
      const where = `${c.id}: noticeTexts[${i}] ${t.file}`;
      const full = resolve(base, t.file);
      const why = unreadable(full);
      if (why) {
        problem(why === "is not there" ? `${where} is not there: the build's fetch step extracts it from ${t.archiveUrl}` : `${where} ${why}`);
        return;
      }
      const bytes = readBytes(full);
      const actual = sha256(bytes);
      if (actual !== t.sha256) problem(`${where} has SHA-256 ${actual}, not the pinned ${t.sha256}`);
      t.bytes = bytes;
    });
    const unmet = (obligation, reason) => problem(`${c.id}: obligation ${obligation} is not met: ${reason}`);
    for (const o of c.obligations) {
      if ((o === "notice" || o === "licence-copy") && c.noticeTexts.length === 0) unmet(o, "noticeTexts is empty");
      if ((o === "source-offer" || o === "relink") && (c.sourceAssets ?? []).length === 0) unmet(o, "sourceAssets is empty");
      if (o === "about-line" && !hasValue(c.aboutLine)) unmet(o, "aboutLine is empty");
    }
  });
  return inventory.components;
}

// The facts of an upstream-binary record that its notice states (PG-D36 (3), (4); the format is
// templates/records/upstream-binary.schema.json). The policy checker owns the rest of the record.
function checkUpstreamBinary(e, id) {
  if (e.file_sha256 === null || e.file_sha256 === undefined) problem(`${id}: the file ${e.file} is not pinned yet (file_sha256 null); pin the SHA-256 of the upstream's release file (PG-D36 (3))`);
  else if (!/^[0-9a-f]{64}$/.test(e.file_sha256)) problem(`${id}: file_sha256 is not a SHA-256`);
  if (!hasValue(e.upstream) || !hasValue(e.file)) problem(`${id}: an upstream-binary record needs upstream and file (PG-D36 (3))`);
  if (!LINKAGES.includes(e.links_microsoft_runtime)) problem(`${id}: links_microsoft_runtime ${e.links_microsoft_runtime} is not one of ${LINKAGES.join(", ")}`);
  else if (e.links_microsoft_runtime === "import" && !(Array.isArray(e.microsoft_runtime_dlls) && e.microsoft_runtime_dlls.length > 0 && e.installer_runtime_check === true)) {
    problem(`${id}: links_microsoft_runtime import needs microsoft_runtime_dlls and installer_runtime_check true (PG-D36 (4))`);
  }
  if (typeof e.passes_on !== "string") problem(`${id}: passes_on must be a string, the upstream's own words (the empty string when it states none)`);
  else if (!PASSES_ON_KINDS.includes(e.passes_on_kind)) problem(`${id}: passes_on_kind ${e.passes_on_kind} is not one of ${PASSES_ON_KINDS.join(", ")}: an upstream that passes on an indemnity or further terms does not ship (PG-D36 (3))`);
  else if (e.passes_on_kind === "none" && e.passes_on.trim() !== "") problem(`${id}: passes_on_kind none needs an empty passes_on`);
  else if (e.passes_on_kind === "listed-restrictions" && (e.passes_on.trim() === "" || !hasValue(e.passes_on_source))) {
    problem(`${id}: passes_on_kind listed-restrictions needs the restrictions in passes_on and their source in passes_on_source`);
  }
}

// The policy's platform entries, each with its pinned text.
function readPlatform(policy) {
  const KINDS = ["separate-program", "toolchain-runtime", "upstream-binary"];
  const entries = [];
  for (const e of policy.platform) {
    const id = e?.name ?? "(a platform entry with no name)";
    if (!hasValue(e?.name) || !hasValue(e.licence) || !hasValue(e.licence_file)) {
      problem(`${id}: a platform entry needs name, licence and licence_file`);
      continue;
    }
    if (!KINDS.includes(e.kind)) {
      problem(`${id}: kind ${e.kind} is not one of ${KINDS.join(", ")}`);
      continue;
    }
    const file = policyFile(e.licence_file);
    const why = unreadable(file);
    let bytes = null;
    if (why) problem(`${id}: licence text ${e.licence_file} ${why}`);
    else if (e.sha256 === null || e.sha256 === undefined) problem(`${id}: licence text ${e.licence_file} is not pinned yet (sha256 null); pin its SHA-256 in the policy (PG-D3)`);
    else {
      bytes = readBytes(file); // never written when the hash below does not match: the run stops first
      const actual = sha256(bytes);
      if (actual !== e.sha256) problem(`${id}: licence text ${e.licence_file} has SHA-256 ${actual}, not the pinned ${e.sha256}`);
    }
    // The line that this licence asks for in the notices (RemObjects Pascal Script: "a visible line ... that it is
    // made using RemObjects Pascal Script and where RemObjects Pascal Script can be found"); it is written
    // under Required acknowledgements in every file, with the about lines of the inventory.
    if (Object.hasOwn(e, "about_line") && !hasValue(e.about_line)) problem(`${id}: about_line must be a non-empty string (the line its licence asks for in the notices)`);
    if (e.kind === "upstream-binary") checkUpstreamBinary(e, id);
    entries.push({ ...e, bytes });
  }
  return entries.sort((a, b) => cmp(a.name, b.name));
}

// ---- rendering -----------------------------------------------------------------------------

const BEGIN_ASSETS = "<!-- BEGIN GENERATED FROM assets.toml -->";
const END_ASSETS = "<!-- END GENERATED FROM assets.toml -->";

// The block between the markers belongs to the asset-records check; it is kept as it stands. A
// per-installer file carries the block of the main THIRD-PARTY-NOTICES.md (the asset-records check
// writes that one file), and its own block only when the main file is not there or has none.
function blockOf(file) {
  if (!existsSync(file)) return null;
  // A copy with CRLF line ends (a Windows checkout with core.autocrlf) still has its block: it is kept with LF.
  const text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const begin = text.indexOf(`${BEGIN_ASSETS}\n`);
  const end = text.indexOf(END_ASSETS);
  return begin >= 0 && end > begin ? text.slice(begin + BEGIN_ASSETS.length + 1, end) : null;
}

function assetsBlock() {
  const main = join(dirname(resolve(OUT)), "THIRD-PARTY-NOTICES.md");
  return (INSTALLER ? blockOf(main) : null) ?? blockOf(OUT) ?? "";
}

const sourceUrl = (c) => {
  if (c.repository) return c.repository;
  if (!c.source) return "";
  if (c.source.startsWith("registry+") || c.source.startsWith("sparse+")) return `https://crates.io/crates/${c.name}/${c.version}`;
  return c.source.replace(/^git\+/, "").replace(/[?#].*$/, "");
};

const INSTALLER_ONLY = "Ships only in the Windows installer and uninstaller.";
const architectureMatches = (c, installer) => c.ships.some((s) => [installer, "any"].includes(String(s.architecture).toLowerCase()));
const installerOnly = (c) => c.ships.every((s) => String(s.package).toLowerCase() === "installer");

function filterComponents(list, installer) {
  const kept = installer === undefined ? list : list.filter((c) => architectureMatches(c, installer));
  return kept
    .map((c) => ({ ...c, contains: filterComponents(c.contains ?? [], installer) }))
    .sort((a, b) => cmp(a.id, b.id));
}

function renderComponent(c, level) {
  const hashes = "#".repeat(Math.min(level, 6));
  let out = `${hashes} ${c.component} ${c.version}\n\n`;
  out += `- Licence: ${c.licence}\n`;
  out += `- Source: ${c.source.url} (${c.source.ref})\n`;
  if (c.source.upstreamSource) out += `- Upstream source: ${c.source.upstreamSource}\n`;
  out += `- Ships in: ${c.ships.map((s) => `${s.package} (${s.architecture}): ${s.location}`).join("; ")}\n`;
  if (installerOnly(c)) out += `- ${INSTALLER_ONLY}\n`;
  out += `- Obligations: ${c.obligations.join(", ")}\n`;
  if (c.obligations.includes("source-offer")) {
    for (const a of [...(c.sourceAssets ?? [])].sort((x, y) => cmp(x.name, y.name))) {
      out += `- The corresponding source of ${c.component} ${c.version} is the release asset \`${a.name}\` (SHA-256 \`${a.sha256}\`) on the same release as this program.\n`;
    }
  }
  if (c.obligations.includes("about-line")) out += `- About line: ${c.aboutLine}\n`;
  out += "\n";
  for (const t of [...c.noticeTexts].sort((a, b) => cmp(a.path, b.path))) {
    const { text, latin1 } = decode(t.bytes);
    out += `**${t.path}**${latin1 ? " (read as Latin-1)" : ""} (SHA-256 of the file \`${t.sha256}\`)\n\n${fenced(text)}\n`;
  }
  for (const sub of c.contains ?? []) out += renderComponent(sub, level + 1);
  return out;
}

// How an upstream binary stands to Microsoft's runtime (PG-D36 (4)): nothing of Microsoft's ships.
function linkage(e) {
  if (e.links_microsoft_runtime === "static") return "static (linked into the file by its upstream)";
  if (e.links_microsoft_runtime === "import") {
    return `import (${[...e.microsoft_runtime_dlls].sort(cmp).join(", ")}); none of it is shipped, the installer checks for it and shows Microsoft's download page when it is missing`;
  }
  return "none";
}

function collectAboutLines(list, into) {
  for (const c of list) {
    if (c.obligations.includes("about-line") && hasValue(c.aboutLine)) into.add(c.aboutLine.trim());
    collectAboutLines(c.contains ?? [], into);
  }
  return into;
}

// The page that the Source column names: the policy's source link for that package and version, else the
// package's own repository or project URL.
const linkFor = (links, ecosystem, name, version) => links.get(`${ecosystem}\0${name.toLowerCase()}\0${version}`);

function render({ cargo, nuget, components, platform, links }) {
  const mode = INSTALLER ? `--write --installer ${INSTALLER}` : "--write";
  // The header names the inputs this run was given: a file made from one report does not claim the other.
  const inputs = [cargo && "cargo-about's report", nuget && "nuget-license's report", "notices/bundled-components.json", "the platform entries of .github/licence-policy.json"].filter(Boolean);
  let out = "# Third-party notices\n\n";
  out += `<!-- This file is generated by \`node .github/scripts/generate-notices.mjs ${mode}\` from ${inputs.slice(0, -1).join(", ")} and ${inputs.at(-1)}. Do not edit it by hand: CI writes it again with the same command and fails when \`git diff --exit-code\` shows a difference. -->\n\n`;
  out += `${values["app-name"]} includes the components below. Their licence and notice texts are reproduced in this file, each as its authors wrote it.\n\n`;

  // the about lines of the inventory and of the platform entries, each once
  const aboutLines = collectAboutLines(components, new Set());
  for (const e of platform) if (hasValue(e.about_line)) aboutLines.add(e.about_line.trim());
  const about = [...aboutLines].sort(cmp);
  if (about.length) out += `## Required acknowledgements\n\n${about.map((l) => `- ${l}`).join("\n")}\n\n`;

  if (cargo || nuget) {
    out += "## Components\n\n";
    if (cargo) {
      out += "### Rust crates\n\n| Component | Version | Licence | Source |\n| --- | --- | --- | --- |\n";
      for (const c of cargo.crates) out += `| ${cell(c.name)} | ${cell(c.version)} | ${cell(c.licence)} | ${cell(linkFor(links, "cargo", c.name, c.version) ?? sourceUrl(c))} |\n`;
      out += "\n";
    }
    if (nuget) {
      out += "### NuGet packages\n\nThe list is nuget-license's: the whole restore graph of the shipped project. It can name packages for operating systems or processors that the published Windows build does not contain.\n\n| Component | Version | Licence | Source |\n| --- | --- | --- | --- |\n";
      for (const p of nuget.packages) out += `| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.licence)} | ${cell(linkFor(links, "nuget", p.name, p.version) ?? p.url ?? `https://www.nuget.org/packages/${p.name}/${p.version}`)} |\n`;
      out += "\n";
    }
  }
  if (cargo) {
    out += "## Licence texts reported by cargo-about\n\n";
    const groups = [...cargo.texts.entries()].sort((a, b) => cmp(`${a[1].id}\0${a[0]}`, `${b[1].id}\0${b[0]}`));
    const authors = new Map(cargo.crates.map((c) => [`${c.name} ${c.version}`, c.authors]));
    for (const [sha, g] of groups) {
      // A text that cargo-about wrote from the SPDX template names no copyright holder: say so, and give the
      // authors that each crate's manifest lists beside it.
      const users = [...g.users.entries()].sort((a, b) => cmp(a[0], b[0])).map(([key, templated]) => (templated ? `${key} (authors: ${(authors.get(key) ?? []).join(", ") || "none listed in its manifest"})` : key));
      out += `### ${g.name} (${g.id}) — ${sha.slice(0, 12)}\n\n`;
      if ([...g.users.values()].some(Boolean)) out += "cargo-about matched no licence file to this licence for the crates listed below with their authors, so it wrote its SPDX template for them; the template names no copyright holder. The authors beside each crate are the ones its manifest lists. The licence files that these crates ship, where they ship any, and the texts that the policy commits for them are written under Notice and licence files from the crate sources.\n\n";
      out += `Used by: ${users.join(", ")}\n\n${fenced(decode(Buffer.from(g.text)).text)}\n`;
    }
    out += "## Notice and licence files from the crate sources\n\n";
    out += cargo.files.length ? verbatimSection(cargo.files) : "No crate source holds such a file.\n\n";
  }
  if (nuget && nuget.pinned.length) {
    out += "## Licence texts for NuGet packages\n\n";
    out += "These packages declare their licence and ship no licence file of their own. Each text is the one the policy pins for that licence, written once; the line beside each package is its own copyright notice.\n\n";
    for (const g of nuget.pinned) {
      out += `### ${g.licence} — ${g.sha.slice(0, 12)}\n\n`;
      out += `SHA-256 of the committed file: \`${g.sha}\`, pinned in .github/licence-policy.json.\n\nUsed by:\n\n${g.users.map((u) => `- ${u}`).join("\n")}\n\n${fenced(decode(g.bytes).text)}\n`;
    }
  }
  if (nuget && nuget.files.length) out += `## Notice and licence files from the NuGet packages\n\n${verbatimSection(nuget.files)}`;

  out += "## Components that are not crates\n\n";
  out += components.length ? components.map((c) => renderComponent(c, 3)).join("") : "No component outside the package managers is shipped.\n\n";

  if (platform.length) {
    out += "## Platform components\n\n";
    for (const e of platform) {
      out += `### ${e.name}\n\n- Kind: ${e.kind}\n- Licence: ${e.licence}\n`;
      if (e.version) out += `- Version: ${e.version}\n`;
      if (e.source) out += `- Source: ${e.source}\n`;
      if (e.kind === "upstream-binary") {
        out += `- Upstream: ${e.upstream}\n`;
        out += `- File: ${e.file} (SHA-256 \`${e.file_sha256}\`)\n`;
        out += `- Links a Microsoft runtime: ${linkage(e)}\n`;
        out += e.passes_on_kind === "none" ? "- Conditions it passes on: none\n" : `- Conditions it passes on (${e.passes_on_source}): ${e.passes_on.trim().replace(/\s*\n\s*/g, " ")}\n`;
      }
      if (e.kind === "separate-program") out += `- ${INSTALLER_ONLY}\n`;
      out += `\n**Licence text** (SHA-256 of the committed file \`${e.sha256}\`, pinned in .github/licence-policy.json)\n\n${fenced(decode(e.bytes).text)}\n`;
    }
  }

  out += `## Attributions for assets\n\n${BEGIN_ASSETS}\n${assetsBlock()}${END_ASSETS}\n`;
  return out;
}

// ---- main ----------------------------------------------------------------------------------

let output;
try {
  const policy = readPolicy(values.policy);
  const links = readSourceLinks(policy);
  const cargo = values["cargo-about"] ? readCargo(values["cargo-about"], readCrateTexts(policy)) : null;
  const nuget = values["nuget-license"] ? readNuget(values["nuget-license"], values["nuget-packages"], policy, readLicenceTexts(policy)) : null;
  const components = filterComponents(readInventory(values.inventory, values.schema), INSTALLER);
  const platform = readPlatform(policy);
  for (const n of notes) console.error(`generate-notices: note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.error(`generate-notices: ${p}`);
    console.error(`generate-notices: ${problems.length} problem${problems.length === 1 ? "" : "s"}; nothing was written`);
    process.exit(1);
  }
  output = render({ cargo, nuget, components, platform, links });
} catch (e) {
  if (!(e instanceof InputError)) throw e;
  usage(e.message);
}

if (values.write) {
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(OUT, output);
  console.log(`generate-notices: wrote ${OUT}`);
} else {
  if (!existsSync(OUT)) {
    console.error(`generate-notices: ${OUT} is not there; write it with \`node .github/scripts/generate-notices.mjs --write\` and commit it`);
    process.exit(1);
  }
  const current = readFileSync(OUT, "utf8");
  if (current === output) {
    console.log(`generate-notices: ${OUT} is current`);
  } else {
    const a = current.split("\n");
    const b = output.split("\n");
    let line = 0;
    while (line < a.length && line < b.length && a[line] === b[line]) line += 1;
    const clip = (s) => (s === undefined ? "(end of file)" : s.length > 100 ? `${s.slice(0, 100)}...` : s);
    console.error(`generate-notices: ${OUT} differs from a fresh generation at line ${line + 1}: expected ${JSON.stringify(clip(b[line]))}, found ${JSON.stringify(clip(a[line]))}`);
    // The same text with LF line ends is current: the copy was changed by a checkout that converts line ends.
    if (current.replace(/\r\n?/g, "\n") === output) console.error("generate-notices: the file differs only in its line ends: it has CR line ends and the generator writes LF; check core.autocrlf and that .gitattributes keeps THIRD-PARTY-NOTICES*.md as LF (eol=lf)");
    console.error("generate-notices: regenerate it with `node .github/scripts/generate-notices.mjs --write` (the same inputs) and commit the result");
    process.exit(1);
  }
}
