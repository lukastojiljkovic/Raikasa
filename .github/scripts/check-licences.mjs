#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Dependency licence gate for the whole shipped tree, on public and private repositories alike
// (dependency review sees only a pull request's diff, and only on public repositories). It reads
// the version-2 whitelist in .github/licence-policy.json (PG-D3; T1 R7 to R9) and passes only
// what the allow list of the dependency's class and the repository's profile names. Everything
// else fails, and the output says why: the deny reason when the policy has one. Nobody accepts a
// licence by hand (PG-D2): the agent writes a clarification in the policy (the true licence is on
// the list, with evidence and the licence file's SHA-256), replaces the dependency, or drops the
// part. A denied component (PG-D31) fails whatever its licence.
//
// Usage:
//   node check-licences.mjs --format pnpm|nuget-license|pip-licenses|gradle|records
//        --report <the tool's JSON output> [--policy .github/licence-policy.json] [--class L]
//   node check-licences.mjs --format platform [--upstream-dir <dir>] [--policy ...]
//   node check-licences.mjs --format scan --path <file or folder> [--path ...] [--policy ...]
//
//   pnpm           pnpm licenses list --prod --json
//   nuget-license  nuget-license -i <solution> -t -o Json
//   pip-licenses   pip-licenses --from=mixed --format=json (add --with-license-file for clarifications)
//   gradle         the Gradle License Report plugin's JsonReportRenderer index.json
//   records        a JSON list of asset, data and model records:
//                  { id, class (L|F|C|M|T), licence, kind (file|pointer), preselected,
//                    datasets: [{ name, licence }], evidence, second_basis: { basis, evidence, url, read, sha256 } }
//   platform       no report: the policy's own `platform` entries (PG-D3, PG-D4, PG-D10, PG-D36 (3)).
//                  Every entry fails while its licence text is unpinned (sha256 null), and its
//                  licence_file (a path from the repository root, or ~/) must hash to the pin. An
//                  upstream binary's own file_sha256 must be pinned too. With --upstream-dir, every
//                  file under that folder must be the `file` (a path relative to the folder) of an
//                  upstream-binary entry and hash to its file_sha256, and every such entry must
//                  find its file there; an unrecorded binary or a spent record fails. An upstream
//                  binary whose passes_on holds an indemnity, a hold-harmless or a duty to make
//                  users accept further terms (the records schema's four word patterns), or whose
//                  passes_on_kind is anything but none or listed-restrictions (a whitelist, as in
//                  generate-notices.mjs: a missing kind fails too), does not ship and fails too. The
//                  kind and the text must agree, as the records schema and generate-notices.mjs require:
//                  none takes an empty passes_on, and listed-restrictions takes the restrictions in
//                  passes_on and their source in passes_on_source; a passes_on that is not a string is a
//                  malformed policy (exit 2).
//   scan           no report: the string scan of the shipped binaries (PG-D31), the backstop of the
//                  denied components. Each --path is a file or a folder (walked); a binary fails
//                  when a printable ASCII run of at least 6 bytes holds one of the policy's
//                  scan_strings, in any letter case. The 6-byte floor keeps random bytes in
//                  compressed data from matching a 4-letter name (inference: a codec library
//                  carries its name in longer banners and symbol strings); UTF-16 strings are
//                  not read, and the dependency graph stays the first check.
//
// --class judges a package report as another class than L (T for a tools-only report).
// Exit codes: 0 no problems; 1 problems; 2 usage error, unreadable report or policy, or a profile
// still at the template placeholder.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { PolicyError, classOf, makeJudge, readPolicy, samePackage } from "./licence-configs.mjs";

const usage = (message) => {
  console.error(message);
  process.exit(2);
};

let values;
try {
  ({ values } = parseArgs({
    options: {
      format: { type: "string" },
      report: { type: "string" },
      policy: { type: "string", default: ".github/licence-policy.json" },
      class: { type: "string", default: "L" },
      "upstream-dir": { type: "string" },
      path: { type: "string", multiple: true },
    },
  }));
} catch (e) {
  usage(e.message);
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return usage(`${what} ${path} could not be read: ${e.message}`);
  }
};

// Each reader returns [{ ecosystem, name, version, licences: [expression, ...], path }]. Several
// expressions on one package are a choice between them (a POM listing two licences). `path` is the
// install folder when the tool reports one; a clarification's licence file may refer to it as {path}.
const READERS = {
  pnpm: (r) =>
    Object.values(r)
      .flat()
      .flatMap((p) => (p.versions ?? [p.version]).map((v, i) => ({ ecosystem: "npm", name: p.name, version: v, licences: [p.license], path: p.paths?.[i] }))),
  "nuget-license": (r) => r.map((p) => ({ ecosystem: "nuget", name: p.PackageId, version: p.PackageVersion, licences: [p.License] })),
  "pip-licenses": (r) =>
    r.map((p) => ({ ecosystem: "pypi", name: p.Name, version: p.Version, licences: [p.License], path: p.LicenseFile && p.LicenseFile !== "UNKNOWN" ? dirname(p.LicenseFile) : undefined })),
  gradle: (r) =>
    (r.dependencies ?? []).map((d) => ({
      ecosystem: "maven",
      name: d.moduleName,
      version: d.moduleVersion,
      licences: d.moduleLicenses ? d.moduleLicenses.map((l) => l.moduleLicense) : [d.moduleLicense],
    })),
};

const OWN_FORMATS = ["records", "platform", "scan"];
const NO_REPORT = ["platform", "scan"];
if (!READERS[values.format] && !OWN_FORMATS.includes(values.format)) usage(`unknown --format ${values.format}; one of ${[...Object.keys(READERS), ...OWN_FORMATS].join(", ")}`);
if (NO_REPORT.includes(values.format) && values.report) usage(`--format ${values.format} reads no report`);
if (!NO_REPORT.includes(values.format) && !values.report) usage("--report is required");
if (values["upstream-dir"] !== undefined && values.format !== "platform") usage("--upstream-dir goes with --format platform");
if (values.path && values.format !== "scan") usage("--path goes with --format scan");
if (values.format === "scan" && !values.path?.length) usage("--format scan needs at least one --path");
if (!["L", "F", "C", "M", "T"].includes(values.class)) usage(`unknown --class ${values.class}; one of L, F, C, M, T`);

let policy;
try {
  policy = readPolicy(values.policy);
} catch (e) {
  if (e instanceof PolicyError) usage(e.message);
  throw e;
}
const judge = makeJudge(policy);
const report = NO_REPORT.includes(values.format) ? null : readJson(values.report, "the report");
const problems = [...policy.problems.map((p) => `the policy: ${p}`)];
const show = (licences) => licences.map((l) => l ?? "(none)").join(" | ");
const RESOLVE = "Write a clarification only if its true licence is on the list; otherwise replace the dependency or drop the part (PG-D2)";
const sha256Of = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// PG-D36 (3): what an upstream binary's passes_on may not hold. These are the four patterns of the passes_on screen in the
// records schema (templates/records/upstream-binary.schema.json), in the same order: an indemnity, a hold-harmless, a duty
// that users, recipients, licensees or distributors must agree to or accept something, and "agree to terms". A heuristic:
// passes_on_kind, which the gate checks too, and a person reading the upstream's terms are the guard.
const PASSES_ON_KINDS = ["none", "listed-restrictions"];
const hasValue = (s) => typeof s === "string" && s.trim() !== "";
const PASSES_ON_REFUSED = /indemni|hold(?:s|ing)?\s+harmless|\b(?:require|obliged?|must|shall)\b[^.]{0,80}\b(?:users?|recipients?|licensees?|distributors?)\b[^.]{0,80}\b(?:agree|accept|consent)\b|agree to terms/i;

let checked = 0;
if (values.format === "records") checkRecords();
else if (values.format === "platform") checkPlatform();
else if (values.format === "scan") checkScan();
else checkPackages();

function checkPackages() {
  let packages;
  try {
    packages = READERS[values.format](report);
  } catch {
    usage(`the report is not ${values.format}'s JSON output`);
  }
  if (!packages.length) usage("the report lists no package: the tool did not run, or found nothing to check");
  checked = packages.length;
  const ecosystem = packages[0].ecosystem;
  const used = new Set();
  for (const p of packages) {
    const id = `${p.name}@${p.version}`;
    const denied = policy.deniedComponents.find((d) => (d[p.ecosystem] ?? []).some((n) => samePackage(p.ecosystem, n, p.name)));
    if (denied) problems.push(`${id} is a denied component (${denied.component}): ${denied.reason}`);

    let licences = p.licences;
    const clar = policy.clarifications.find((c) => c.ecosystem === p.ecosystem && samePackage(p.ecosystem, c.package, p.name) && c.version === p.version);
    if (clar) {
      used.add(clar);
      const stale = verifyLicenceFile(clar, p);
      if (stale) {
        problems.push(`${id}: its clarification no longer holds: ${stale}; check the licence again and update or remove the clarification (PG-D2)`);
        continue;
      }
      licences = [clar.licence];
    }
    const cls = values.class === "L" ? classOf(policy, p.ecosystem, p.name) : values.class;
    const verdicts = licences.map((l) => judge(l, { cls, ecosystem: p.ecosystem, pkg: p.name }));
    if (verdicts.some((v) => v.verdict === "allowed")) continue;
    const isDenied = verdicts.some((v) => v.verdict === "denied");
    const reasons = [...new Set(verdicts.flatMap((v) => v.reasons))].join("; ");
    problems.push(`${id} (${show(licences)}) is ${isDenied ? "denied" : "not allowed"} in ${cls === "L" ? `class L of profile ${policy.profile}` : `class ${cls}`}: ${reasons}. ${RESOLVE}`);
  }
  for (const c of policy.clarifications) {
    if (c.ecosystem === ecosystem && !used.has(c)) problems.push(`the clarification for ${c.package}@${c.version} matches no package any more: it is spent, delete it`);
  }
}

// The licence file a clarification pins must still hash the same, or the clarification is stale.
function verifyLicenceFile(clar, p) {
  let path = clar.licence_file.path;
  if (path.includes("{path}")) {
    if (!p.path) return `the report gives no install path for ${p.name}, so ${path} cannot be found`;
    path = path.replace("{path}", p.path);
  }
  if (path.startsWith("~/")) path = `${homedir()}${path.slice(1)}`;
  let bytes;
  try {
    bytes = readFileSync(resolve(path));
  } catch {
    return `its licence file ${path} is missing`;
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  return sha === clar.licence_file.sha256 ? "" : `its licence file ${path} has SHA-256 ${sha}, not the pinned ${clar.licence_file.sha256}`;
}

function checkRecords() {
  if (!Array.isArray(report) || !report.length) usage("the records report lists no record");
  checked = report.length;
  const ids = (expr) => new Set(String(expr ?? "").match(/[^\s()]+/g) ?? []);
  const usOnlyRefs = Object.entries(policy.refs)
    .filter(([, def]) => (def.requires ?? []).includes("second_basis"))
    .map(([ref]) => ref);
  for (const r of report) {
    const id = r.id ?? "(no id)";
    if (!r.id || !["L", "F", "C", "M", "T"].includes(r.class) || !["file", "pointer"].includes(r.kind ?? "file")) {
      problems.push(`${id}: a record needs id, class (L|F|C|M|T) and kind (file|pointer)`);
      continue;
    }
    const pointer = r.kind === "pointer";
    if (policy.pointerOnly.includes(r.class) && !pointer) {
      problems.push(`${id}: class ${r.class} is pointer-only: no model file is bundled, hosted, committed or published; the app fetches it from the rights holder's own upload at the user's action (PG-D33)`);
    }
    const v = judge(r.licence, { cls: r.class, tier2: pointer });
    let tier2 = v.tier2;
    if (v.verdict !== "allowed") {
      problems.push(`${id} (${show([r.licence])}) is ${v.verdict === "denied" ? "denied" : "not allowed"} in class ${r.class}: ${v.reasons.join("; ")}`);
      continue;
    }
    // PG-D33 (4): the training data counts in a model's tier.
    // A dataset with no stated licence, or with only a US-framed status, makes it tier 2 at most.
    for (const d of r.class === "M" ? (r.datasets ?? []) : []) {
      const lic = d.licence ?? "";
      if (!lic || usOnlyRefs.some((ref) => ids(lic).has(ref))) tier2 = true;
      else if (judge(lic, { cls: "C" }).verdict === "allowed") continue;
      else if (judge(lic, { cls: "M", tier2: true }).tier2) tier2 = true;
      else problems.push(`${id}: its dataset ${d.name ?? "(unnamed)"} (${lic}) is neither tier 1 nor tier 2, so the model is out (PG-D33 (4))`);
    }
    if (tier2 && !pointer) problems.push(`${id}: a tier-2 licence is never committed, bundled or hosted (PG-D2)`);
    if (tier2 && r.preselected) problems.push(`${id}: a tier-2 item is never preselected, recommended or the default; the user fetches it by an explicit action with the licence shown first (PG-D2)`);
    // Licence ids that need fields of their own (licence_refs.requires).
    for (const [ref, def] of Object.entries(policy.refs)) {
      if (!ids(r.licence).has(ref)) continue;
      for (const field of def.requires ?? []) {
        if (field === "second_basis") {
          const b = r.second_basis;
          const ok = b && ["A", "B", "C"].includes(b.basis) && b.evidence && b.url && /^\d{4}-\d{2}-\d{2}$/.test(b.read ?? "") && /^[0-9a-f]{64}$/.test(b.sha256 ?? "");
          if (!ok) problems.push(`${id} (${ref}): a US-only basis is never enough on its own; the record needs second_basis { basis A|B|C, evidence, url, read, sha256 }, or the item is not distributed (PG-D32)`);
        } else if (!r[field]) {
          problems.push(`${id} (${ref}): the record needs ${field} (${def.meaning})`);
        }
      }
    }
  }
}

// Every file under a folder, as paths relative to it with forward slashes.
function walkFiles(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) visit(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)).split(sep).join("/"));
    }
  };
  visit(dir);
  return out.sort();
}

// The platform entries: licence texts pinned by hash (PG-D3), the toolchain records (PG-D10) and
// the upstream-binary records (PG-D36 (3)). A null pin is the template's "not pinned yet", and it
// fails here until the adopting repository pins it.
function checkPlatform() {
  checked = policy.platform.length;
  for (const e of policy.platform) {
    const id = `the platform entry ${e.name} (${e.kind})`;
    if (e.sha256 === null) {
      problems.push(`${id}: its licence text ${e.licence_file} is not pinned yet (sha256 null); keep the text in the repository and pin its SHA-256 (PG-D3, PG-D10)`);
    } else {
      const stale = verifyLicenceFile({ licence_file: { path: e.licence_file, sha256: e.sha256 } }, { name: e.name });
      if (stale) problems.push(`${id}: ${stale}; read the licence again and update the entry (PG-D2, PG-D3)`);
    }
    if (e.kind === "upstream-binary" && e.file_sha256 === null) {
      problems.push(`${id}: the binary ${e.file} is not pinned yet (file_sha256 null); pin the SHA-256 of the upstream's release file (PG-D36 (3))`);
    }
    if (e.kind === "upstream-binary") {
      if (PASSES_ON_REFUSED.test(e.passes_on ?? "") || ["indemnity", "further-terms"].includes(e.passes_on_kind)) {
        problems.push(`${id}: its passes_on holds an indemnity or a duty to make users accept further terms, so the binary does not ship (PG-D36 (3)): remove the entry and the file`);
      } else if (!PASSES_ON_KINDS.includes(e.passes_on_kind)) {
        // The kinds are a whitelist, as in generate-notices.mjs (PG-D36 (3)): anything but these two fails, a missing kind included.
        problems.push(`${id}: its passes_on_kind is ${JSON.stringify(e.passes_on_kind) ?? "missing"}, not none or listed-restrictions, so the binary does not ship (PG-D36 (3)): state the kind the upstream's terms have, or remove the entry and the file`);
      } else if (e.passes_on_kind === "none" && e.passes_on.trim() !== "") {
        // The records schema's allOf, with generate-notices.mjs's wording (checkUpstreamBinary). passes_on is a string here:
        // compilePolicy refuses any other (exit 2). Without this rule a further-terms clause the word screen misses passes
        // under the kind none.
        problems.push(`${id}: passes_on_kind none needs an empty passes_on`);
      } else if (e.passes_on_kind === "listed-restrictions" && (e.passes_on.trim() === "" || !hasValue(e.passes_on_source))) {
        problems.push(`${id}: passes_on_kind listed-restrictions needs the restrictions in passes_on and their source in passes_on_source`);
      }
    }
  }
  if (values["upstream-dir"] !== undefined) checkUpstreamDir(values["upstream-dir"]);
}

// Every binary in the folder the build vendors upstream binaries into has a record, and every
// record still names a file there.
function checkUpstreamDir(dir) {
  const records = policy.platform.filter((e) => e.kind === "upstream-binary");
  const norm = (p) => String(p).replaceAll("\\", "/").replace(/^\.\//, "");
  const files = existsSync(dir) && statSync(dir).isDirectory() ? walkFiles(dir) : [];
  checked += files.length;
  const seen = new Set();
  for (const rel of files) {
    const e = records.find((r) => norm(r.file) === rel);
    if (!e) {
      problems.push(`${dir}/${rel} ships with no upstream-binary record (file, file_sha256, upstream, licence, links_microsoft_runtime, passes_on; PG-D36 (3)): record it, or stop shipping it`);
      continue;
    }
    seen.add(e);
    const sha = sha256Of(join(dir, rel));
    if (e.file_sha256 && sha !== e.file_sha256) {
      problems.push(`${dir}/${rel} has SHA-256 ${sha}, not the recorded ${e.file_sha256} of ${e.name}: a changed upstream binary needs its record checked again (PG-D36 (3))`);
    }
  }
  for (const e of records) {
    if (!seen.has(e)) problems.push(`the upstream-binary record ${e.name} names ${e.file}, which ${dir} does not hold: the record is spent, delete it, or fix the build that vendors it`);
  }
}

// The string scan of the shipped binaries (PG-D31): printable ASCII runs of at least 6 bytes.
function checkScan() {
  const needles = policy.deniedComponents.flatMap((d) => (d.scan_strings ?? []).map((s) => ({ s: s.toLowerCase(), d })));
  const files = [];
  for (const p of values.path) {
    if (!existsSync(p)) usage(`--path ${p} does not exist`);
    if (statSync(p).isDirectory()) files.push(...walkFiles(p).map((rel) => `${p.replace(/[\\/]+$/, "")}/${rel}`));
    else files.push(p);
  }
  if (!files.length) usage("the --path arguments hold no file");
  checked = files.length;
  for (const f of files) {
    const text = (readFileSync(f).toString("latin1").match(/[\x20-\x7e]{6,}/g) ?? []).join("\n").toLowerCase();
    for (const { s, d } of needles) {
      if (text.includes(s)) problems.push(`${f} holds the string "${s}" of a denied component (${d.component}): ${d.reason}`);
    }
  }
}

const summary = problems.length
  ? `### Dependency licences: ${problems.length} problem(s) in ${checked} item(s)\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`
  : `### Dependency licences: ${checked} item(s), no problems (profile ${policy.profile})\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(problems.length ? 1 : 0);
