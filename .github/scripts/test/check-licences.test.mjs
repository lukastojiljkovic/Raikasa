// SPDX-License-Identifier: MIT
// The dependency licence gate against the version-2 policy (PG-D3): a whitelist per class and
// profile, deny reasons, clarifications pinned by hash, denied components, and the record checks
// of PG-D32 and PG-D33. Every case names the break it catches. The fixtures start from the
// template's own policy file, so the real lists are what is tested.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { SCRIPTS, run } from "./helpers.mjs";

const TEMPLATE = JSON.parse(readFileSync(resolve(SCRIPTS, "..", "licence-policy.json"), "utf8"));
// The per-repository lists start empty in every case: an adopting repository fills them with its own
// entries (own_sources for the kit crates, a NuGet clarification), and its own entries must not change a
// case. A case that needs one passes it through `extra` (B0-U01). The `rust` settings are per-repository too (a
// second target, a git source, an ignored advisory); the gate does not read them, so they start from the template's one target and no exception.
const policyFor = (profile = "gpl", extra = {}) => ({ ...structuredClone(TEMPLATE), profile, own_sources: [], clarifications: [], class_overrides: [], lgpl_dynamic: [], rust: { ...structuredClone(TEMPLATE.rust), targets: ["x86_64-pc-windows-gnullvm"], allow_git: [], advisories_ignore: [] }, ...extra });
const SHA = "a".repeat(64);

function gate(format, report, policy = policyFor(), args = [], files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "licences-test-"));
  writeFileSync(join(dir, "report.json"), typeof report === "string" ? report : JSON.stringify(report));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const r = run("check-licences.mjs", ["--format", format, "--report", "report.json", "--policy", "policy.json", ...args], dir);
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const pnpm = (byLicence) =>
  Object.fromEntries(Object.entries(byLicence).map(([lic, names]) => [lic, names.map((n) => ({ name: n, versions: ["1.0.0"], paths: ["."], license: lic }))]));

test("pnpm: a tree of whitelisted licences passes", () => {
  const r = gate("pnpm", pnpm({ MIT: ["a", "b"], "Apache-2.0": ["c"], "GPL-3.0-or-later": ["d"], "LGPL-2.1-only": ["e"], "BlueOak-1.0.0": ["f"], "MIT-0": ["g"] }));
  assert.equal(r.code, 0, r.out);
});

test("a denied licence fails, names the package and prints the deny reason", () => {
  const r = gate("pnpm", pnpm({ MIT: ["a"], "SSPL-1.0": ["mongo-thing"] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /mongo-thing@1\.0\.0 \(SSPL-1\.0\) is denied.*SSPL-1\.0: offering the program as a service/);
});

test("a licence nobody listed fails, and no path accepts it by hand", () => {
  const r = gate("pnpm", pnpm({ "Foo-1.0": ["odd"] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /odd@1\.0\.0 \(Foo-1\.0\) is not allowed.*not on the allow list of class L of profile gpl.*Write a clarification only if/);
  const old = gate("pnpm", pnpm({ "Foo-1.0": ["odd"] }), policyFor("gpl", { accepted: [{ package: "odd", licence: "Foo-1.0", reason: "x", until: "2099-01-01" }] }));
  assert.equal(old.code, 1, "an old `accepted` list must not let anything through");
});

test("the profile changes class L: gpl-le takes no GPL and says why", () => {
  const r = gate("pnpm", pnpm({ "GPL-3.0-or-later": ["gplthing"] }), policyFor("gpl-le"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gplthing@1\.0\.0.*profile gpl-le.*only the copyright holder can grant the linking exception/);
  assert.equal(gate("pnpm", pnpm({ "LGPL-3.0-only": ["l"] }), policyFor("reserved")).code, 1, "the CV takes no LGPL");
  assert.equal(gate("pnpm", pnpm({ "LGPL-3.0-only": ["l"] }), policyFor("permissive")).code, 0);
});

test("gpl-le admits LGPL only for a separately loaded library named in lgpl_dynamic", () => {
  const policy = policyFor("gpl-le", { lgpl_dynamic: [{ ecosystem: "nuget", package: "Loose", file: "Loose.dll", sha256: SHA, why: "loaded at run time" }] });
  const report = [{ PackageId: "Loose", PackageVersion: "1.0.0", License: "LGPL-3.0-only" }, { PackageId: "Tight", PackageVersion: "1.0.0", License: "LGPL-3.0-only" }];
  const r = gate("nuget-license", report, policy);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /Loose@1\.0\.0/);
  assert.match(r.out, /Tight@1\.0\.0.*lgpl_dynamic/);
});

test("SPDX expressions: OR needs one acceptable choice, AND needs all, WITH keeps the base licence", () => {
  assert.equal(gate("pnpm", pnpm({ "(MIT OR GPL-2.0-only)": ["dual"] })).code, 0);
  assert.equal(gate("pnpm", pnpm({ "MIT AND GPL-2.0-only": ["both"] })).code, 1);
  assert.equal(gate("pnpm", pnpm({ "GPL-2.0-only WITH Classpath-exception-2.0": ["cp"] })).code, 1);
  assert.equal(gate("pnpm", pnpm({ "Apache-2.0 AND (MIT OR Foo-1.0)": ["mix"] })).code, 0);
  assert.equal(gate("pnpm", pnpm({ "Apache-2.0 WITH LLVM-exception": ["llvm"] }), policyFor("gpl-le")).code, 0);
});

test("each SPDX expression form has its exit code and names the part that fails (B0-U01)", () => {
  // OR: one acceptable choice passes; no acceptable choice fails and every refusal is printed.
  assert.equal(gate("pnpm", pnpm({ "MIT OR Foo-1.0": ["a"] })).code, 0, "OR: one listed choice is enough");
  const orBad = gate("pnpm", pnpm({ "Foo-1.0 OR Bar-2.0": ["b"] }));
  assert.equal(orBad.code, 1, orBad.out);
  assert.match(orBad.out, /b@1\.0\.0 \(Foo-1\.0 OR Bar-2\.0\) is not allowed.*Foo-1\.0 is not on the allow list.*Bar-2\.0 is not on the allow list/);
  const orDenied = gate("pnpm", pnpm({ "SSPL-1.0 OR Foo-1.0": ["c"] }));
  assert.equal(orDenied.code, 1, orDenied.out);
  assert.match(orDenied.out, /c@1\.0\.0.*SSPL-1\.0: offering the program as a service/);
  // AND: every part must pass, and the denied part is the one named.
  assert.equal(gate("pnpm", pnpm({ "MIT AND Apache-2.0": ["d"] })).code, 0, "AND: both listed");
  const andBad = gate("pnpm", pnpm({ "MIT AND SSPL-1.0": ["e"] }));
  assert.equal(andBad.code, 1, andBad.out);
  assert.match(andBad.out, /e@1\.0\.0 \(MIT AND SSPL-1\.0\) is denied.*SSPL-1\.0: offering the program as a service/);
  assert.doesNotMatch(andBad.out, /MIT is not on the allow list/, "the passing part is not blamed");
  const andUnknown = gate("pnpm", pnpm({ "MIT AND Foo-1.0": ["f"] }));
  assert.equal(andUnknown.code, 1, andUnknown.out);
  assert.match(andUnknown.out, /f@1\.0\.0.*is not allowed.*Foo-1\.0 is not on the allow list/);
  // WITH: the whole expression when listed, else the base licence; an exception only adds permissions.
  assert.equal(gate("pnpm", pnpm({ "Apache-2.0 WITH LLVM-exception": ["g"] }), policyFor("reserved")).code, 0, "WITH: the whole expression is listed");
  assert.equal(gate("pnpm", pnpm({ "MIT WITH Some-exception": ["h"] })).code, 0, "WITH: an unlisted exception on a listed base passes");
  const withBad = gate("pnpm", pnpm({ "GPL-2.0-only WITH Classpath-exception-2.0": ["i"] }));
  assert.equal(withBad.code, 1, withBad.out);
  assert.match(withBad.out, /i@1\.0\.0.*is denied.*GPL-2\.0-only: GPL-incompatible in linked code/);
});

test("the deny map beats an allow list that names the same id, and applies to classes L, F, C and M but not to class T (B0-U01)", () => {
  // The policy itself is contradictory, so it fails with its own line; the package must also be denied (not merely allowed).
  const broad = policyFor("gpl");
  broad.allow.L.common.push("EPL-2.0", "CC-BY-NC-4.0");
  const epl = gate("pnpm", pnpm({ "EPL-2.0": ["eclipse-thing"] }), broad);
  assert.equal(epl.code, 1, epl.out);
  assert.match(epl.out, /the policy: allow\.L lists EPL-2\.0, which deny also matches \(EPL-2\.0\)/);
  assert.match(epl.out, /eclipse-thing@1\.0\.0 \(EPL-2\.0\) is denied in class L of profile gpl: EPL-2\.0: GPL-incompatible in linked code unless GPL is named/);
  const glob = gate("pnpm", pnpm({ "CC-BY-NC-4.0": ["nc-thing"] }), broad);
  assert.equal(glob.code, 1, glob.out);
  assert.match(glob.out, /the policy: allow\.L lists CC-BY-NC-4\.0, which deny also matches \(CC-BY-NC-\*\)/, "a glob deny entry catches an exact allow entry");
  assert.match(glob.out, /nc-thing@1\.0\.0 \(CC-BY-NC-4\.0\) is denied in class L of profile gpl: CC-BY-NC-4\.0: non-commercial/);
  // Class F, C and M lists: an entry the deny map matches is a policy problem too.
  for (const cls of ["F", "C", "M"]) {
    const p = policyFor("gpl");
    p.allow[cls].push("SSPL-1.0");
    const r = gate("records", [{ id: "rec", class: cls, licence: "SSPL-1.0", kind: "pointer" }], p);
    assert.equal(r.code, 1, `${cls}: ${r.out}`);
    assert.match(r.out, new RegExp(`the policy: allow\\.${cls} lists SSPL-1\\.0, which deny also matches`), cls);
    assert.match(r.out, new RegExp(`rec \\(SSPL-1\\.0\\) is denied in class ${cls}`), cls);
  }
  // Class T uses only its own list: EPL-2.0 is a build tool's licence and does not count against it.
  assert.equal(gate("pnpm", pnpm({ "EPL-2.0": ["eclipse-tool"] }), policyFor("gpl"), ["--class", "T"]).code, 0, "T: deny does not apply");
  const asL = gate("pnpm", pnpm({ "EPL-2.0": ["eclipse-tool"] }));
  assert.equal(asL.code, 1, "the same package as class L is denied");
  assert.match(asL.out, /eclipse-tool@1\.0\.0 \(EPL-2\.0\) is denied/);
});

test("a spent clarification fails in each package ecosystem the gate reads, and a clarification for another ecosystem is not spent by this report (B0-U01)", () => {
  // One report per format, each listing one package that no clarification names, and the ecosystem and the
  // package name a clarification would carry in it.
  const formats = [
    { format: "pnpm", ecosystem: "npm", package: "old-lib", report: pnpm({ MIT: ["other"] }) },
    { format: "nuget-license", ecosystem: "nuget", package: "Old.Lib", report: [{ PackageId: "Other", PackageVersion: "1.0.0", License: "MIT" }] },
    { format: "pip-licenses", ecosystem: "pypi", package: "old-lib", report: [{ Name: "other", Version: "1.0.0", License: "MIT License" }] },
    { format: "gradle", ecosystem: "maven", package: "org.example:old-lib", report: { dependencies: [{ moduleName: "org.example:other", moduleVersion: "1.0.0", moduleLicense: "MIT" }] } },
  ];
  // A NuGet clarification pins the installed file (a committed copy is refused, B0-U13); the others keep a path from the root.
  const clarification = ({ ecosystem, package: pkg }) => ({ ecosystem, package: pkg, version: "1.0.0", licence: "MIT", evidence: "e", read: "2026-11-18", licence_file: { path: ecosystem === "nuget" ? `~/.nuget/packages/${pkg.toLowerCase()}/1.0.0/LICENSE.txt` : "L", sha256: SHA } });
  for (const f of formats) {
    const spent = gate(f.format, f.report, policyFor("gpl", { clarifications: [clarification(f)] }));
    assert.equal(spent.code, 1, `${f.format}: ${spent.out}`);
    assert.ok(spent.out.includes(`the clarification for ${f.package}@1.0.0 matches no package any more: it is spent, delete it`), `${f.format}: ${spent.out}`);
    // The same clarification against every other format's report is not judged there, so it is not spent there.
    for (const other of formats.filter((o) => o !== f)) {
      const elsewhere = gate(other.format, other.report, policyFor("gpl", { clarifications: [clarification(f)] }));
      assert.equal(elsewhere.code, 0, `a ${f.ecosystem} clarification is judged only against a ${f.ecosystem} report, not ${other.format}: ${elsewhere.out}`);
    }
  }
});

test("pip-licenses: classifier names map through the aliases", () => {
  const r = gate("pip-licenses", [{ Name: "requests", Version: "2.32.0", License: "Apache License, Version 2.0" }, { Name: "attrs", Version: "24.0", License: "MIT License" }]);
  assert.equal(r.code, 0, r.out);
});

test("nuget-license: a package without licence information is denied with the reason, not allowed", () => {
  const r = gate("nuget-license", [{ PackageId: "Good", PackageVersion: "1.0.0", License: "MIT" }, { PackageId: "Vague", PackageVersion: "2.0.0" }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Vague@2\.0\.0 \(\(none\)\) is denied.*no licence stated/);
});

test("Gradle licence report: several licences on one module are a choice", () => {
  const ok = { dependencies: [{ moduleName: "g:a", moduleVersion: "1", moduleLicenses: [{ moduleLicense: "GPL-2.0-only" }, { moduleLicense: "Apache License, Version 2.0" }] }] };
  assert.equal(gate("gradle", ok).code, 0);
  const bad = { dependencies: [{ moduleName: "g:b", moduleVersion: "1", moduleLicense: "Unknown" }] };
  const r = gate("gradle", bad);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /g:b@1.*denied.*UNKNOWN|g:b@1.*denied.*Unknown/);
});

test("a clarification holds while its licence file hashes the same; a changed file or a spent entry fails", () => {
  const text = "Permission is hereby granted, free of charge (MIT)\n";
  const sha = createHash("sha256").update(text).digest("hex");
  const clar = { ecosystem: "npm", package: "khroma", version: "1.0.0", licence: "MIT", evidence: "upstream LICENSE", read: "2026-11-18", licence_file: { path: "{path}/LICENSE", sha256: sha } };
  const policy = policyFor("gpl", { clarifications: [clar] });
  const report = pnpm({ UNKNOWN: ["khroma"] });
  assert.equal(gate("pnpm", report, policy, [], { LICENSE: text }).code, 0);
  const stale = gate("pnpm", report, policy, [], { LICENSE: `${text}changed\n` });
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /khroma@1\.0\.0: its clarification no longer holds.*not the pinned/);
  const spent = gate("pnpm", pnpm({ MIT: ["a"] }), policy, [], { LICENSE: text });
  assert.equal(spent.code, 1, spent.out);
  assert.match(spent.out, /khroma@1\.0\.0 matches no package any more: it is spent/);
});

// A NuGet clarification pins the licence file inside the installed package, under ~/.nuget/packages (nuget-license reports
// no install path, and overrides.json gives the package its licence by id and version, so the installed file's hash is the
// one pin). The case points ~ at a folder of its own (USERPROFILE on Windows, HOME elsewhere). A committed copy as the pin
// is a malformed policy (B0-U13).
test("a NuGet clarification pinned by the installed file holds while that file hashes the same; a changed installed file fails, and a committed copy as the pin is refused (B0-U13)", () => {
  const dir = mkdtempSync(join(tmpdir(), "licences-nuget-home-"));
  try {
    const text = "B0Proof Planted Package Licence\n\nPermission is granted to use, copy, modify and redistribute it.\n";
    const installed = join(dir, "home", ".nuget", "packages", "b0proof.planted.filelicence", "1.0.0", "LICENSE.txt");
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, text);
    const clar = (path) => ({ ecosystem: "nuget", package: "B0Proof.Planted.FileLicence", version: "1.0.0", licence: "MIT", evidence: "e", read: "2026-11-25", licence_file: { path, sha256: sha256(text) } });
    // What nuget-license reports with the generated override: the clarified licence, by id and version.
    writeFileSync(join(dir, "report.json"), JSON.stringify([{ PackageId: "B0Proof.Planted.FileLicence", PackageVersion: "1.0.0", License: "MIT" }, { PackageId: "Other", PackageVersion: "2.0.0", License: "Apache-2.0" }]));
    const check = (path) => {
      writeFileSync(join(dir, "policy.json"), JSON.stringify(policyFor("gpl", { clarifications: [clar(path)] })));
      return run("check-licences.mjs", ["--format", "nuget-license", "--report", "report.json", "--policy", "policy.json"], dir, { USERPROFILE: join(dir, "home"), HOME: join(dir, "home") });
    };
    const home = "~/.nuget/packages/b0proof.planted.filelicence/1.0.0/LICENSE.txt";
    const holds = check(home);
    assert.equal(holds.code, 0, holds.out);
    writeFileSync(installed, `${text}This package may be used only for non-commercial evaluation.\n`);
    const changed = check(home);
    assert.equal(changed.code, 1, changed.out);
    assert.match(changed.out, /B0Proof\.Planted\.FileLicence@1\.0\.0: its clarification no longer holds: its licence file \S+LICENSE\.txt has SHA-256 [0-9a-f]{64}, not the pinned/);
    // The committed copy still holds the old text, and the same changed installed file: refused before any package is read.
    writeFileSync(join(dir, "LICENSE-copy.txt"), text);
    const copy = check("LICENSE-copy.txt");
    assert.equal(copy.code, 2, copy.out);
    assert.match(copy.out, /the NuGet clarification for B0Proof\.Planted\.FileLicence@1\.0\.0 pins LICENSE-copy\.txt, a copy in the repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clarification must name a whitelisted licence: the policy itself fails otherwise", () => {
  const clar = { ecosystem: "npm", package: "x", version: "1.0.0", licence: "SSPL-1.0", evidence: "e", read: "2026-11-18", licence_file: { path: "L", sha256: SHA } };
  const r = gate("pnpm", pnpm({ MIT: ["a"] }), policyFor("gpl", { clarifications: [clar] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the policy: the clarification for x@1\.0\.0 names SSPL-1\.0.*SSPL-1\.0: offering/);
});

test("a denied component fails whatever its licence (PG-D31)", () => {
  const r = gate("pnpm", pnpm({ MIT: ["a"], "GPL-3.0-or-later": ["ffmpeg-static"] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ffmpeg-static@1\.0\.0 is a denied component \(full FFmpeg builds\).*PG-D31/);
});

test("a font package named in class_overrides is judged as class F", () => {
  const report = pnpm({ "OFL-1.1": ["some-font"] });
  assert.equal(gate("pnpm", report).code, 1, "OFL is not class L");
  const policy = policyFor("gpl", { class_overrides: [{ ecosystem: "npm", package: "some-font", class: "F", why: "bundles a font" }] });
  const r = gate("pnpm", report, policy);
  assert.equal(r.code, 0, r.out);
});

test("records: class M is pointer-only, and a tier-2 model is a pointer the user fetches, never preselected", () => {
  const r = gate("records", [{ id: "model-a", class: "M", licence: "Apache-2.0", kind: "file" }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /model-a: class M is pointer-only.*PG-D33/);
  assert.equal(gate("records", [{ id: "model-b", class: "M", licence: "Apache-2.0", kind: "pointer" }]).code, 0);
  assert.equal(gate("records", [{ id: "model-c", class: "M", licence: "CC-BY-NC-4.0", kind: "pointer" }]).code, 0);
  const pre = gate("records", [{ id: "model-d", class: "M", licence: "CC-BY-NC-4.0", kind: "pointer", preselected: true }]);
  assert.equal(pre.code, 1, pre.out);
  assert.match(pre.out, /model-d: a tier-2 item is never preselected/);
  const hosted = gate("records", [{ id: "data-e", class: "C", licence: "CC-BY-NC-4.0", kind: "file" }]);
  assert.equal(hosted.code, 1, hosted.out);
  assert.match(hosted.out, /data-e.*denied.*non-commercial/);
});

test("records: a model's datasets count in its tier", () => {
  const ok = gate("records", [{ id: "m1", class: "M", licence: "MIT", kind: "pointer", datasets: [{ name: "d", licence: "CC-BY-4.0" }], preselected: true }]);
  assert.equal(ok.code, 0, ok.out);
  const nc = gate("records", [{ id: "m2", class: "M", licence: "MIT", kind: "pointer", datasets: [{ name: "d", licence: "CC-BY-NC-4.0" }], preselected: true }]);
  assert.equal(nc.code, 1, nc.out);
  assert.match(nc.out, /m2: a tier-2 item is never preselected/);
  const none = gate("records", [{ id: "m3", class: "M", licence: "MIT", kind: "pointer", datasets: [{ name: "d" }], preselected: true }]);
  assert.equal(none.code, 1, "a dataset with no stated licence makes the model tier 2");
});

test("records: a US-only basis needs a second basis (PG-D32)", () => {
  const bare = gate("records", [{ id: "usgov", class: "C", licence: "LicenseRef-PD-USGov", kind: "file" }]);
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.out, /usgov \(LicenseRef-PD-USGov\): a US-only basis is never enough on its own/);
  const second = { basis: "A", evidence: "released under CC0", url: "https://example.org/cc0", read: "2026-11-18", sha256: SHA };
  assert.equal(gate("records", [{ id: "usgov", class: "C", licence: "LicenseRef-PD-USGov", kind: "file", second_basis: second }]).code, 0);
  const pd = gate("records", [{ id: "old", class: "C", licence: "LicenseRef-Public-Domain", kind: "file" }]);
  assert.equal(pd.code, 1, pd.out);
  assert.match(pd.out, /old \(LicenseRef-Public-Domain\): the record needs evidence/);
});

test("a profile still at the template placeholder, or a version-1 policy, is refused", () => {
  const placeholder = gate("pnpm", pnpm({ MIT: ["a"] }), policyFor(`{{tpl:${"LICENCE_PROFILE"}}}`));
  assert.equal(placeholder.code, 2, placeholder.out);
  assert.match(placeholder.out, /still the template placeholder/);
  const v1 = gate("pnpm", pnpm({ MIT: ["a"] }), { deny: [], allow: ["MIT"], accepted: [] });
  assert.equal(v1.code, 2, v1.out);
  assert.match(v1.out, /version 2/);
});

test("an empty or unreadable report is an error, never a pass", () => {
  assert.equal(gate("pnpm", {}).code, 2);
  assert.equal(gate("pnpm", "not json").code, 2);
  assert.equal(gate("cargo", pnpm({ MIT: ["a"] })).code, 2);
  assert.equal(gate("nuget-license", { not: "a list" }).code, 2);
});

// ---- platform entries (PG-D3, PG-D4, PG-D10, PG-D36 (3)) and the string scan (PG-D31) ----

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Runs the gate in a fresh folder holding `files` (paths with forward slashes; a Buffer is written as is).
function own(args, policy = policyFor(), files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "licences-own-"));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const r = run("check-licences.mjs", [...args, "--policy", "policy.json"], dir);
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const INNO_TEXT = "Inno Setup License\n";
const PM_TEXT = "MIT License\n";
const PM_BIN = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]);
const pinned = (extra = {}) => [
  { name: "Inno Setup", kind: "separate-program", licence: "InnoSetup", source: "s", licence_file: "third_party/inno/license.txt", sha256: sha256(INNO_TEXT), duties: ["d"], why: "w" },
  {
    name: "PresentMon", kind: "upstream-binary", licence: "MIT", source: "s", licence_file: "third_party/presentmon/LICENSE.txt", sha256: sha256(PM_TEXT),
    file: "PresentMon.exe", file_sha256: sha256(PM_BIN), upstream: "u", links_microsoft_runtime: "static", passes_on: "", passes_on_kind: "none", duties: ["d"], why: "w", ...extra,
  },
];
const PINNED_FILES = { "third_party/inno/license.txt": INNO_TEXT, "third_party/presentmon/LICENSE.txt": PM_TEXT };

test("platform: every entry with a null pin fails, each named (a null pin is not a pass)", () => {
  // A fixed list of three kinds-of-entry, not the repository's own policy: an adopted repository may drop
  // entries (an Electron repository has no mingw-w64 or LLVM runtime) and this case must not care.
  // The path has no space: the gate prints it, and the case matches it with \S+.
  const entry = (name, kind, licence) => ({ name, kind, licence, source: "s", licence_file: `licences/${name.replaceAll(" ", "-")}.txt`, sha256: null, duties: ["d"], why: "w" });
  const platform = [entry("Inno Setup", "separate-program", "InnoSetup"), entry("mingw-w64 runtime", "toolchain-runtime", "LicenseRef-mingw-w64-runtime"), entry("LLVM libunwind", "toolchain-runtime", "Apache-2.0 WITH LLVM-exception")];
  const r = own(["--format", "platform"], policyFor("gpl", { platform }));
  assert.equal(r.code, 1, r.out);
  for (const { name } of platform) {
    const line = r.out.split("\n").find((l) => l.includes(`the platform entry ${name} (`)) ?? "";
    assert.match(line, /: its licence text \S+ is not pinned yet \(sha256 null\)/, `${name} is not named as unpinned:\n${r.out}`);
  }
});

test("platform: the template's own entries are pinned, and each committed licence text hashes to its pin (B0-U01)", () => {
  // Run from the repository root, as the licence job does: the licence_file paths are read from there.
  const dir = mkdtempSync(join(tmpdir(), "licences-template-"));
  try {
    const policy = structuredClone(TEMPLATE);
    if (policy.profile.includes("{{tpl:")) policy.profile = "gpl";
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    const r = run("check-licences.mjs", ["--format", "platform", "--policy", join(dir, "policy.json")], resolve(SCRIPTS, "..", ".."));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`${policy.platform.length} item\\(s\\), no problems`));
    for (const e of policy.platform) assert.match(e.sha256 ?? "", /^[0-9a-f]{64}$/, `${e.name} is pinned`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("platform: pinned entries whose licence texts match pass", () => {
  const r = own(["--format", "platform"], policyFor("gpl", { platform: pinned() }), PINNED_FILES);
  assert.equal(r.code, 0, r.out);
});

test("platform: a changed or missing licence text fails", () => {
  const changed = own(["--format", "platform"], policyFor("gpl", { platform: pinned() }), { ...PINNED_FILES, "third_party/inno/license.txt": "Inno Setup License, changed\n" });
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /Inno Setup \(separate-program\): its licence file third_party\/inno\/license\.txt has SHA-256 [0-9a-f]{64}, not the pinned/);
  const missing = own(["--format", "platform"], policyFor("gpl", { platform: pinned() }), { "third_party/inno/license.txt": INNO_TEXT });
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /PresentMon \(upstream-binary\): its licence file third_party\/presentmon\/LICENSE\.txt is missing/);
});

test("platform: an upstream binary needs its own pin, and the policy refuses one without file_sha256", () => {
  const unpinned = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ file_sha256: null }) }), PINNED_FILES);
  assert.equal(unpinned.code, 1, unpinned.out);
  assert.match(unpinned.out, /PresentMon \(upstream-binary\): the binary PresentMon\.exe is not pinned yet/);
  const entries = pinned();
  delete entries[1].file_sha256;
  const malformed = own(["--format", "platform"], policyFor("gpl", { platform: entries }), PINNED_FILES);
  assert.equal(malformed.code, 2, malformed.out);
  assert.match(malformed.out, /an upstream binary also needs file, file_sha256/);
});

test("platform: an upstream binary whose passes_on holds an indemnity or a duty to make users accept further terms does not ship (PG-D36 (3), B0-U01)", () => {
  // The texts are the words the records schema's passes_on screen refuses: an indemnity or hold-harmless, and a duty to make
  // users or distributors agree to terms. The first two are the realistic cases; each of the next nine is caught by one of the
  // schema's four patterns alone (so dropping any one pattern, or any one word form of the hold-harmless pattern, fails here),
  // and the last is upper case. The gate prints the same line for the words and for the two refused kinds.
  const refused = /PresentMon \(upstream-binary\): its passes_on holds an indemnity or a duty to make users accept further terms/;
  for (const passes_on of [
    "The distributor must indemnify, defend and hold harmless the upstream.",
    "You must require distributors and external end users to agree to terms that protect it.",
    "The distributor owes the upstream an indemnity.", // the indemnity pattern alone
    "The distributor must hold harmless the upstream.", // the hold-harmless pattern alone
    "The licensee holds harmless the upstream.", // the hold-harmless pattern, the form "holds"
    "The licensee is holding harmless the upstream.", // the hold-harmless pattern, the form "holding"
    "The upstream shall make every recipient accept a further licence.", // the duty pattern alone, by recipients
    "The upstream may require each distributor to accept further terms.", // by distributors
    "The upstream shall make every licensee consent to further terms.", // by licensees, with consent
    "The upstream shall make users agree to a separate licence.", // by users
    "Redistributors agree to terms set by the upstream.", // "agree to terms" alone
    "THE DISTRIBUTOR SHALL INDEMNIFY THE UPSTREAM.", // letter case
  ]) {
    const r = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ passes_on }) }), PINNED_FILES);
    assert.equal(r.code, 1, `${passes_on}: ${r.out}`);
    assert.match(r.out, refused, passes_on);
  }
  for (const passes_on_kind of ["indemnity", "further-terms"]) {
    const r = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ passes_on_kind }) }), PINNED_FILES);
    assert.equal(r.code, 1, `${passes_on_kind}: ${r.out}`);
    assert.match(r.out, refused, passes_on_kind);
  }
  // The kinds are a whitelist, as in generate-notices.mjs: an upstream binary whose passes_on_kind is not none or
  // listed-restrictions does not ship, whatever it is: a name the screen has never heard of, an empty string, a number,
  // null, or no kind at all. So nothing passes by being left out, and the words are not the only guard.
  for (const passes_on_kind of ["flow-down", "", "Indemnity", 7, null, undefined]) {
    const r = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ passes_on_kind }) }), PINNED_FILES);
    assert.equal(r.code, 1, `${JSON.stringify(passes_on_kind)}: ${r.out}`);
    assert.match(r.out, /PresentMon \(upstream-binary\): its passes_on_kind is .*, not none or listed-restrictions, so the binary does not ship \(PG-D36 \(3\)\)/, String(passes_on_kind));
  }
  const missing = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ passes_on_kind: undefined }) }), PINNED_FILES);
  assert.match(missing.out, /its passes_on_kind is missing, not none or listed-restrictions/, missing.out);
  const none = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ passes_on_kind: "none" }) }), PINNED_FILES);
  assert.equal(none.code, 0, none.out);
  // Listed restrictions that only have to be kept are not refused, and the screen reads upstream-binary entries only.
  const kept = own(["--format", "platform"], policyFor("gpl", { platform: pinned({ passes_on: "Do not remove the copyright notice; do not claim the file as your own.", passes_on_kind: "listed-restrictions", passes_on_source: "the upstream's LICENSE, section 2" }) }), PINNED_FILES);
  assert.equal(kept.code, 0, kept.out);
  const other = pinned();
  other[0].passes_on = "The distributor must indemnify the upstream.";
  const separate = own(["--format", "platform"], policyFor("gpl", { platform: other }), PINNED_FILES);
  assert.equal(separate.code, 0, separate.out);
});

// The records schema's allOf, which generate-notices.mjs enforces too (checkUpstreamBinary): the kind and the text must
// agree. check-licences --format platform is the CI gate on an upstream binary, so it applies the same rules, with
// generate-notices.mjs's wording. The first text is a further-terms clause the word screen does not catch (its word order
// is "Users must agree", and "agree to the terms" is not "agree to terms"), so only the kind rule stops it (B0-U01).
test("platform: an upstream binary's kind and passes_on agree: none takes an empty passes_on, listed-restrictions takes the restrictions and passes_on_source, and passes_on is a string (PG-D36 (3), B0-U01)", () => {
  const gate = (extra) => own(["--format", "platform"], policyFor("gpl", { platform: pinned(extra) }), PINNED_FILES);
  const noneLine = /PresentMon \(upstream-binary\): passes_on_kind none needs an empty passes_on/;
  const listedLine = /PresentMon \(upstream-binary\): passes_on_kind listed-restrictions needs the restrictions in passes_on and their source in passes_on_source/;
  for (const passes_on of ["Users must agree to the terms of the EULA.", "Keep the notice.", " x "]) {
    const r = gate({ passes_on, passes_on_kind: "none" });
    assert.equal(r.code, 1, `none with ${JSON.stringify(passes_on)}: ${r.out}`);
    assert.match(r.out, noneLine, passes_on);
  }
  assert.equal(gate({ passes_on: " \n", passes_on_kind: "none" }).code, 0, "white space only is an empty passes_on, as in generate-notices.mjs (trim)");
  for (const passes_on of ["", "   "]) {
    const r = gate({ passes_on, passes_on_kind: "listed-restrictions", passes_on_source: "the upstream's LICENSE" });
    assert.equal(r.code, 1, `listed-restrictions with ${JSON.stringify(passes_on)}: ${r.out}`);
    assert.match(r.out, listedLine, `blank passes_on ${JSON.stringify(passes_on)}`);
  }
  for (const passes_on_source of [undefined, "", "  ", 7]) {
    const r = gate({ passes_on: "Keep the notice.", passes_on_kind: "listed-restrictions", passes_on_source });
    assert.equal(r.code, 1, `listed-restrictions with passes_on_source ${JSON.stringify(passes_on_source)}: ${r.out}`);
    assert.match(r.out, listedLine, `passes_on_source ${JSON.stringify(passes_on_source)}`);
  }
  // A passes_on that is not a string is a malformed policy (licence-configs.mjs compilePolicy): exit 2, as for the other
  // fields an upstream binary needs, never a pass.
  for (const passes_on of [7, null, ["Keep the notice."], undefined]) {
    const r = gate({ passes_on, passes_on_kind: "none" });
    assert.equal(r.code, 2, `passes_on ${JSON.stringify(passes_on)}: ${r.out}`);
    assert.match(r.out, /an upstream binary also needs file, file_sha256 \(null until pinned\), upstream, links_microsoft_runtime \(static\|import\|none\) and passes_on \(PG-D36 \(3\)\): PresentMon/);
  }
});

test("platform --upstream-dir: a recorded binary that matches passes", () => {
  const r = own(["--format", "platform", "--upstream-dir", "build/vendor"], policyFor("gpl", { platform: pinned() }), { ...PINNED_FILES, "build/vendor/PresentMon.exe": PM_BIN });
  assert.equal(r.code, 0, r.out);
});

test("platform --upstream-dir: an unrecorded binary, a changed binary and a spent record each fail", () => {
  const policy = policyFor("gpl", { platform: pinned() });
  const extra = own(["--format", "platform", "--upstream-dir", "build/vendor"], policy, { ...PINNED_FILES, "build/vendor/PresentMon.exe": PM_BIN, "build/vendor/pawnio/PawnIO_setup.exe": "x" });
  assert.equal(extra.code, 1, extra.out);
  assert.match(extra.out, /build\/vendor\/pawnio\/PawnIO_setup\.exe ships with no upstream-binary record/);
  const changed = own(["--format", "platform", "--upstream-dir", "build/vendor"], policy, { ...PINNED_FILES, "build/vendor/PresentMon.exe": Buffer.from("other") });
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /build\/vendor\/PresentMon\.exe has SHA-256 [0-9a-f]{64}, not the recorded/);
  const spent = own(["--format", "platform", "--upstream-dir", "build/vendor"], policy, PINNED_FILES);
  assert.equal(spent.code, 1, spent.out);
  assert.match(spent.out, /the upstream-binary record PresentMon names PresentMon\.exe, which build\/vendor does not hold: the record is spent/);
});

test("platform: a repository with no platform entry and no vendored binary passes; a report is refused", () => {
  assert.equal(own(["--format", "platform", "--upstream-dir", "build/vendor"], policyFor("gpl", { platform: [] })).code, 0);
  assert.equal(own(["--format", "platform", "--report", "x.json"], policyFor("gpl", { platform: [] })).code, 2);
});

test("scan: a binary that carries a denied codec's string fails and names the component", () => {
  const bin = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("OpenH264 encoder version"), Buffer.from([0, 0xff])]);
  const r = own(["--format", "scan", "--path", "dist"], policyFor(), { "dist/app.exe": Buffer.from("MZ clean binary\0"), "dist/sub/codec.dll": bin });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /dist\/sub\/codec\.dll holds the string "openh264" of a denied component \(H\.264 and HEVC codecs\)/);
  assert.doesNotMatch(r.out, /app\.exe holds/);
});

test("scan: lossy WebP's libwebp is caught (PG-D31)", () => {
  const r = own(["--format", "scan", "--path", "app.exe"], policyFor(), { "app.exe": Buffer.from("\0\0libwebp-1.5.0\0") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"libwebp" of a denied component \(lossy WebP \(VP8\)\)/);
});

test("scan: clean binaries pass, and a 4-letter name inside random bytes is not a match", () => {
  const noise = Buffer.from([0x01, 0x78, 0x32, 0x36, 0x34, 0x02, 0x03]); // \x01 x264 \x02: a 4-byte run
  const r = own(["--format", "scan", "--path", "a.exe", "--path", "b.dll"], policyFor(), { "a.exe": Buffer.from("MZ\0This program cannot be run in DOS mode\0"), "b.dll": noise });
  assert.equal(r.code, 0, r.out);
});

test("scan: a missing path or no path is an error, never a pass", () => {
  assert.equal(own(["--format", "scan", "--path", "nothing-here"]).code, 2);
  assert.equal(own(["--format", "scan"]).code, 2);
});
