#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generates every tool's licence configuration from the one policy file,
// .github/licence-policy.json (version 2), so the lists cannot drift apart
// (PG-D3; T1 R7, R8; engineering-standard.md §3.10):
//
//   deny.toml                                  cargo-deny 0.20: [licenses] allow, exceptions
//                                              and clarify; [bans] denied components and features
//   about.toml                                 cargo-about 0.9: accepted, per-crate accepted
//                                              and clarify
//   .github/dependency-review-config.yml       actions/dependency-review-action: allow-licenses,
//                                              allow-dependencies-licenses, deny-packages, allow-ghsas
//   .github/nuget-license/allowed-licenses.json  nuget-license 4.0: the allowed licence types
//   .github/nuget-license/overrides.json      nuget-license 4.0 --override-package-information:
//                                              { Id, Version, License } per NuGet clarification
//   .github/nuget-license/licensefile-mappings.json  nuget-license 4.0
//                                              --licensefile-to-license-mappings: always {}, because
//                                              a NuGet clarification pins the installed file, never
//                                              a committed copy (B0-U13)
//
// The two last files are bare JSON (an array and an object) and carry no header; --check guards
// them like the rest.
//
// Usage:
//   node .github/scripts/licence-configs.mjs --write   rewrite the files the policy's `generate` lists
//   node .github/scripts/licence-configs.mjs --check   regenerate in memory; exit 1 on any difference
//   options: --policy .github/licence-policy.json  --root .   (the repository root)
//
// Exit codes: 0 done or no drift; 1 drift, or an entry whose licence the policy itself does not
// allow; 2 usage error, an unreadable or malformed policy, or a profile still at the template
// placeholder. No dependencies: Node's standard library only.
//
// The module also exports the policy reader and the licence judge, which check-licences.mjs uses,
// so both scripts read the policy the same way.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const PROFILES = ["gpl", "gpl-le", "reserved", "permissive"];
export const ECOSYSTEMS = ["cargo", "npm", "nuget", "pypi", "maven"];
export const PLATFORM_KINDS = ["separate-program", "toolchain-runtime", "upstream-binary"];
const SHIPPED_CLASSES = ["L", "F", "C", "M"]; // the classes `deny` applies to
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA = /^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$/; // GitHub's advisory ids use these 23 characters only
const GENERATOR = ".github/scripts/licence-configs.mjs";
const POLICY_PATH = ".github/licence-policy.json";

export class PolicyError extends Error {}

const fail = (message) => {
  throw new PolicyError(message);
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const lower = (s) => String(s).toLowerCase();

// A licence-id glob: `*` matches anything; everything else is literal; case does not matter.
export const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");

// Package names compare without case; PyPI names also treat runs of - _ . as one separator.
export function samePackage(ecosystem, a, b) {
  const norm = (s) => (ecosystem === "pypi" ? lower(s).replace(/[-_.]+/g, "-") : lower(s));
  return norm(a) === norm(b);
}

export function readPolicy(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`the policy ${path} could not be read: ${e.message}`);
  }
  return compilePolicy(raw);
}

// Checks the policy's shape and compiles it. A malformed policy throws PolicyError (exit 2). An
// entry whose licence the policy itself does not allow is a licence problem, returned in
// `problems` (exit 1), so the message carries the deny reason like any other failure.
export function compilePolicy(p) {
  if (!isObject(p)) fail("the policy is not a JSON object");
  if (p.version !== 2) fail(`the policy is version ${p.version ?? "(none)"}; these scripts read version 2 (PG-D3)`);
  if (typeof p.profile !== "string") fail("the policy has no profile");
  if (p.profile.includes("{{tpl:")) {
    fail(
      `the policy's profile is still the template placeholder ${p.profile}: set "profile" to one of ` +
        `${PROFILES.join(", ")} (licensing.md §0; PG-D1), then run node ${GENERATOR} --write`,
    );
  }
  if (!PROFILES.includes(p.profile)) fail(`unknown profile ${p.profile}; one of ${PROFILES.join(", ")} (PG-D1)`);
  const a = p.allow;
  if (!isObject(a) || !isObject(a.L) || !strings(a.L.common) || !strings(a.L[p.profile])) {
    fail(`allow.L needs a "common" list and a "${p.profile}" list`);
  }
  for (const c of ["F", "C", "M", "T"]) if (!strings(a[c])) fail(`allow.${c} must be a list of licence ids`);
  if (!isObject(a.P) || !PLATFORM_KINDS.every((k) => strings(a.P[k]))) fail(`allow.P needs a list for each of ${PLATFORM_KINDS.join(", ")}`);
  if (!isObject(p.deny) || !Object.values(p.deny).every((r) => typeof r === "string" && r)) fail("deny maps each licence id to its reason");
  if (!isObject(p.tier2) || !strings(p.tier2.classes) || !strings(p.tier2.licences)) fail("tier2 needs classes and licences lists");
  if (!strings(p.pointer_only)) fail("pointer_only must be a list of classes");
  if (!isObject(p.aliases ?? {})) fail("aliases must map names to SPDX ids");
  if (!isObject(p.licence_refs ?? {}) || !Object.values(p.licence_refs ?? {}).every((r) => isObject(r) && strings(r.requires ?? []))) {
    fail("licence_refs maps each LicenseRef id to { meaning, requires: [fields] }");
  }
  for (const k of ["class_overrides", "lgpl_dynamic", "clarifications", "platform", "denied_components", "denied_features", "own_sources", "allow_ghsas"]) {
    if (!Array.isArray(p[k] ?? [])) fail(`${k} must be a list`);
  }
  // Advisories the dependency review accepts: each names its reason on one line and the date it is reviewed again.
  const ghsas = new Set();
  for (const g of p.allow_ghsas ?? []) {
    if (!isObject(g) || !GHSA.test(g.id ?? "") || typeof g.reason !== "string" || !g.reason.trim() || /[\r\n]/.test(g.reason) || !DATE.test(g.until ?? "")) {
      fail(`an allow_ghsas entry needs id (GHSA-xxxx-xxxx-xxxx), reason (one line) and until (YYYY-MM-DD): ${JSON.stringify(g)}`);
    }
    if (ghsas.has(g.id.toLowerCase())) fail(`${g.id} is listed twice in allow_ghsas`);
    ghsas.add(g.id.toLowerCase());
  }
  if (!isObject(p.rust ?? {})) fail("rust must be an object");
  const rust = { targets: [], advisories_ignore: [], allow_git: [], ...(p.rust ?? {}) };
  if (!strings(rust.targets) || !strings(rust.allow_git) || !Array.isArray(rust.advisories_ignore)) fail("rust needs targets, advisories_ignore and allow_git lists");
  for (const x of rust.advisories_ignore) if (!x?.id || !x?.reason) fail(`every ignored advisory needs id and reason: ${JSON.stringify(x)}`);
  if (!strings(p.generate) || p.generate.some((g) => !(g in RENDERERS))) fail(`generate lists files from: ${Object.keys(RENDERERS).join(", ")}`);

  const policy = {
    raw: p,
    profile: p.profile,
    rust,
    aliases: new Map(Object.entries(p.aliases ?? {}).map(([k, v]) => [lower(k), v])),
    refs: p.licence_refs ?? {},
    deny: Object.entries(p.deny).map(([pattern, reason]) => ({ pattern, re: glob(pattern), reason })),
    tier2: { classes: p.tier2.classes, res: p.tier2.licences.map(glob) },
    pointerOnly: p.pointer_only,
    profileReasons: Object.entries(p.profile_reasons?.[p.profile] ?? {}).map(([pattern, reason]) => ({ re: glob(pattern), reason })),
    lists: {
      L: [...new Set([...a.L.common, ...a.L[p.profile]])],
      F: a.F,
      C: a.C,
      M: a.M,
      T: a.T,
      "P:separate-program": a.P["separate-program"],
      "P:upstream-binary": a.P["upstream-binary"],
      "P:toolchain-runtime": [...new Set([...a.L.common, ...a.L[p.profile], ...a.P["toolchain-runtime"]])],
    },
    classOverrides: p.class_overrides ?? [],
    lgplDynamic: p.lgpl_dynamic ?? [],
    clarifications: p.clarifications ?? [],
    platform: p.platform ?? [],
    deniedComponents: p.denied_components ?? [],
    deniedFeatures: p.denied_features ?? [],
    ownSources: p.own_sources ?? [],
    allowGhsas: p.allow_ghsas ?? [],
    generate: p.generate,
    problems: [],
  };

  for (const o of policy.classOverrides) {
    if (!ECOSYSTEMS.includes(o.ecosystem) || !o.package || !["F", "C"].includes(o.class) || !o.why) {
      fail(`a class override needs ecosystem (${ECOSYSTEMS.join("|")}), package, class (F or C) and why: ${JSON.stringify(o)}`);
    }
  }
  for (const l of policy.lgplDynamic) {
    if (!ECOSYSTEMS.includes(l.ecosystem) || !l.package || !l.file || !SHA256.test(l.sha256 ?? "") || !l.why) {
      fail(`an lgpl_dynamic entry needs ecosystem, package, file, sha256 and why: ${JSON.stringify(l)}`);
    }
  }
  const cargoClarified = new Set();
  for (const c of policy.clarifications) {
    const f = c.licence_file;
    if (!ECOSYSTEMS.includes(c.ecosystem) || !c.package || !c.version || !c.licence || !c.evidence || !DATE.test(c.read ?? "") || !isObject(f) || !f.path || !SHA256.test(f.sha256 ?? "")) {
      fail(`a clarification needs ecosystem, package, version, licence, evidence, read (YYYY-MM-DD) and licence_file { path, sha256 }: ${JSON.stringify(c)}`);
    }
    if (c.ecosystem === "cargo") {
      if (!/^0x[0-9a-f]{1,8}$/i.test(f.cargo_deny_hash ?? "")) fail(`a cargo clarification also needs licence_file.cargo_deny_hash, the value cargo-deny prints (0x...): ${c.package}`);
      if (cargoClarified.has(lower(c.package))) fail(`two cargo clarifications for ${c.package}: cargo-about keys clarifications by crate name, so keep one`);
      cargoClarified.add(lower(c.package));
    }
    // overrides.json gives a NuGet package its licence by id and version, whatever its own licence file holds, so only
    // the installed file's hash (check-licences.mjs) pins the package; a committed copy would pin nothing (B0-U13).
    if (c.ecosystem === "nuget" && !installedFilePin(String(f.path))) {
      const what = /^([A-Za-z]:)?[\\/]/.test(String(f.path)) ? "an absolute path: a copy in the repository reached through the checkout, or a file on one machine" : "a copy in the repository";
      fail(
        `the NuGet clarification for ${c.package}@${c.version} pins ${f.path}, ${what}: overrides.json gives the package ` +
          "its licence by id and version whatever the package's own file holds, so only the installed file pins it. Name that file: " +
          "~/.nuget/packages/<id in lower case>/<version in lower case>/<file> (B0-U13)",
      );
    }
  }
  for (const e of policy.platform) {
    if (!e.name || !PLATFORM_KINDS.includes(e.kind) || !e.licence || !e.source || !e.licence_file || !(e.sha256 === null || SHA256.test(e.sha256 ?? "")) || !strings(e.duties) || !e.why) {
      fail(`a platform entry needs name, kind (${PLATFORM_KINDS.join("|")}), licence, source, licence_file, sha256 (null until pinned), duties and why: ${JSON.stringify(e.name ?? e)}`);
    }
    if (
      e.kind === "upstream-binary" &&
      (!e.file || !(e.file_sha256 === null || SHA256.test(e.file_sha256 ?? "")) || !e.upstream || !["static", "import", "none"].includes(e.links_microsoft_runtime) || typeof e.passes_on !== "string")
    ) {
      fail(`an upstream binary also needs file, file_sha256 (null until pinned), upstream, links_microsoft_runtime (static|import|none) and passes_on (PG-D36 (3)): ${e.name}`);
    }
  }
  for (const d of policy.deniedComponents) {
    if (!d.component || !d.reason || !ECOSYSTEMS.every((k) => strings(d[k] ?? [])) || !strings(d.scan_strings ?? [])) {
      fail(`a denied component needs component, reason and package lists per ecosystem: ${JSON.stringify(d.component ?? d)}`);
    }
  }
  for (const d of policy.deniedFeatures) if (!d.crate || !strings(d.features) || !d.reason) fail(`a denied feature entry needs crate, features and reason: ${JSON.stringify(d)}`);
  // Luka's own crates from another of his repositories (S-27 kit crates, the S-01 crate): admitted
  // by source, each with its own licence exception; class L is unchanged (licensing.md §0).
  const ownCrates = new Set();
  for (const o of policy.ownSources) {
    if (o?.ecosystem !== "cargo" || typeof o.source !== "string" || !/^https:\/\/\S+$/.test(o.source) || !strings(o.crates) || !o.crates.length || o.crates.some((c) => !c) || typeof o.licence !== "string" || !o.why) {
      fail(`an own_sources entry needs ecosystem (cargo), source (an https git URL), crates (a non-empty list), licence and why: ${JSON.stringify(o)}`);
    }
    for (const c of o.crates) {
      if (ownCrates.has(lower(c))) fail(`${c} is listed twice in own_sources`);
      ownCrates.add(lower(c));
      const clash = [...policy.classOverrides, ...policy.clarifications].find((x) => x.ecosystem === "cargo" && samePackage("cargo", x.package, c));
      if (clash) fail(`${c} is in own_sources and also in class_overrides or clarifications: an own crate takes its licence from own_sources only`);
    }
    if (!["gpl", "gpl-le"].includes(policy.profile)) {
      policy.problems.push(`own_sources ${o.source}: profile ${policy.profile} takes no GPL crates, and Luka's own crates are GPL (only gpl and gpl-le take them; licensing.md §0)`);
    }
    if (!/^GPL-3\.0-or-later( WITH [A-Za-z0-9.+-]+)?$/.test(o.licence)) {
      policy.problems.push(`own_sources ${o.source} names ${o.licence}: Luka's own crates are GPL-3.0-or-later, optionally WITH an exception (licensing.md §0)`);
    }
  }

  // The policy may not contradict itself or carry an entry its own lists refuse.
  const judge = makeJudge(policy);
  for (const [key, list] of Object.entries(policy.lists)) {
    const cls = key.startsWith("P:") ? "P" : key;
    if (!SHIPPED_CLASSES.includes(cls)) continue;
    for (const id of list) {
      const d = policy.deny.find((x) => x.re.test(id));
      if (d) policy.problems.push(`allow.${key} lists ${id}, which deny also matches (${d.pattern}): ${d.reason}`);
    }
  }
  for (const c of policy.clarifications) {
    const cls = classOf(policy, c.ecosystem, c.package);
    const v = judge(c.licence, { cls, ecosystem: c.ecosystem, pkg: c.package });
    if (v.verdict !== "allowed") policy.problems.push(`the clarification for ${c.package}@${c.version} names ${c.licence}, which class ${cls} of profile ${policy.profile} does not allow: ${v.reasons.join("; ")}`);
  }
  for (const e of policy.platform) {
    const v = judge(e.licence, { cls: "P", kind: e.kind });
    if (v.verdict !== "allowed") policy.problems.push(`the platform entry ${e.name} (${e.kind}) carries ${e.licence}, which allow.P.${e.kind} does not list: ${v.reasons.join("; ")}`);
  }
  return policy;
}

export function classOf(policy, ecosystem, name) {
  return policy.classOverrides.find((o) => o.ecosystem === ecosystem && samePackage(ecosystem, o.package, name))?.class ?? "L";
}

// The licence judge. judge(expression, { cls, kind, ecosystem, pkg, tier2 }) returns
// { verdict: allowed | denied | unknown, reasons: [..], tier2: bool }. An SPDX expression: OR is a
// choice, AND needs every part, `X WITH E` passes when the whole expression is listed or else is
// judged on X (an exception only adds permissions).
export function makeJudge(policy) {
  const listFor = (cls, kind) => policy.lists[cls === "P" ? `P:${kind}` : cls] ?? [];
  return function judge(expression, { cls = "L", kind, ecosystem, pkg, tier2 = false } = {}) {
    const allowed = new Set(listFor(cls, kind).map(lower));
    if (cls === "L" && policy.profile === "gpl-le" && pkg && policy.lgplDynamic.some((l) => l.ecosystem === ecosystem && samePackage(ecosystem, l.package, pkg))) {
      for (const id of ["LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later"]) allowed.add(lower(id));
    }
    const applyDeny = SHIPPED_CLASSES.includes(cls) || (cls === "P" && kind === "toolchain-runtime");
    const where = cls === "L" ? `class L of profile ${policy.profile}` : cls === "P" ? `allow.P.${kind}` : `class ${cls}`;
    let usedTier2 = false;

    const judgeId = (raw, combined) => {
      const id = policy.aliases.get(lower(raw)) ?? raw;
      if (combined && allowed.has(lower(combined))) return { verdict: "allowed", reasons: [] };
      if (tier2 && policy.tier2.classes.includes(cls) && policy.tier2.res.some((r) => r.test(id))) {
        usedTier2 = true;
        return { verdict: "allowed", reasons: [] };
      }
      const d = applyDeny && policy.deny.find((x) => x.re.test(id));
      if (d) return { verdict: "denied", reasons: [`${id}: ${d.reason}`] };
      if (allowed.has(lower(id))) return { verdict: "allowed", reasons: [] };
      const why = cls === "L" ? policy.profileReasons.find((x) => x.re.test(id))?.reason : undefined;
      return { verdict: "unknown", reasons: [`${id} is not on the allow list of ${where}${why ? `: ${why}` : ""}`] };
    };
    const merge = (parts, any) => {
      const order = any ? ["allowed", "unknown", "denied"] : ["denied", "unknown", "allowed"];
      const verdict = order.find((v) => parts.some((x) => x.verdict === v));
      return { verdict, reasons: verdict === "allowed" ? [] : parts.filter((x) => x.verdict !== "allowed").flatMap((x) => x.reasons) };
    };

    let text = (expression ?? "").toString().trim();
    if (!text || /^(undefined|null)$/i.test(text)) text = "NONE";
    let result;
    if (policy.aliases.has(lower(text)) || !/\s(or|and|with)\s|[()]/i.test(text)) {
      result = judgeId(text);
    } else {
      const tokens = text.match(/\(|\)|[^\s()]+/g);
      let i = 0;
      const peek = () => tokens[i];
      const factor = () => {
        if (peek() === "(") {
          i++;
          const v = or();
          if (peek() === ")") i++;
          return v;
        }
        const id = tokens[i++] ?? "";
        if (/^with$/i.test(peek() ?? "")) {
          const exception = tokens[i + 1] ?? "";
          i += 2;
          return judgeId(id, `${policy.aliases.get(lower(id)) ?? id} WITH ${exception}`);
        }
        return judgeId(id);
      };
      const and = () => {
        const parts = [factor()];
        while (/^and$/i.test(peek() ?? "")) {
          i++;
          parts.push(factor());
        }
        return merge(parts, false);
      };
      const or = () => {
        const parts = [and()];
        while (/^or$/i.test(peek() ?? "")) {
          i++;
          parts.push(and());
        }
        return merge(parts, true);
      };
      result = or();
    }
    return { ...result, tier2: usedTier2 };
  };
}

// ---- the generated files -------------------------------------------------------------------

// Licences a tool config may carry: an id that needs per-record fields (licence_refs.requires)
// is left out, because only check-licences.mjs sees those fields.
const toolList = (policy, cls) => policy.lists[cls].filter((id) => !(policy.refs[id]?.requires ?? []).length);
const q = (s) => JSON.stringify(String(s)); // a TOML basic string
const key = (s) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : q(s));
const tomlList = (items, indent = "") => (items.length ? `[\n${items.map((x) => `${indent}  ${x},`).join("\n")}\n${indent}]` : "[]");

function header(policy, comment, extra = []) {
  return [
    `Generated by ${GENERATOR} from ${POLICY_PATH}`,
    `(profile ${policy.profile}). Do not edit: change the policy and run`,
    `  node ${GENERATOR} --write`,
    "CI runs it with --check, which fails when this file differs from what the policy generates (PG-D3).",
    ...extra,
  ].map((l) => `${comment} ${l}`.trimEnd());
}

function renderDeny(policy) {
  const out = [
    ...header(policy, "#", ["cargo-deny 0.20 format (cargo-deny 0.20.2). Engineering standard §3.2 and §3.10."]),
    "",
    "[graph]",
    `targets = ${JSON.stringify(policy.rust.targets)}`,
    "all-features = true",
    "",
    "[advisories]",
    "# Every RustSec advisory fails the build, unmaintained and unsound included. An ignored",
    "# advisory is listed in the policy's rust.advisories_ignore with its reason and the",
    "# condition that retires it.",
    `ignore = ${tomlList(policy.rust.advisories_ignore.map((x) => `{ id = ${q(x.id)}, reason = ${q(x.reason)} }`))}`,
    "",
    "[licenses]",
    `# Class L of profile ${policy.profile}. Every other licence fails (PG-D2): write a clarification in`,
    "# the policy, replace the crate, or drop the part. No licence is accepted by hand.",
    `allow = ${tomlList(toolList(policy, "L").map(q))}`,
    "confidence-threshold = 0.8",
    "# One program-wide list, so a crate tree uses only part of it.",
    'unused-allowed-license = "allow"',
    "",
    "[licenses.private]",
    "# Our own workspace crates (publish = false) carry the repository's licence and are not judged.",
    "ignore = true",
  ];
  for (const o of policy.classOverrides.filter((x) => x.ecosystem === "cargo")) {
    out.push("", `# Judged as class ${o.class}: ${o.why}`, "[[licenses.exceptions]]", `crate = ${q(o.package)}`, `allow = ${tomlList(toolList(policy, o.class).map(q))}`);
  }
  for (const o of policy.ownSources) {
    for (const name of o.crates) {
      out.push("", `# Luka's own crate from ${o.source} (own_sources): ${o.why}`, "[[licenses.exceptions]]", `crate = ${q(name)}`, `allow = ${tomlList([q(o.licence)])}`);
    }
  }
  for (const c of policy.clarifications.filter((x) => x.ecosystem === "cargo")) {
    out.push(
      "",
      `# ${c.evidence} (read ${c.read})`,
      "[[licenses.clarify]]",
      `crate = ${q(`${c.package}@${c.version}`)}`,
      `expression = ${q(c.licence)}`,
      `license-files = [{ path = ${q(c.licence_file.path)}, hash = ${c.licence_file.cargo_deny_hash} }]`,
    );
  }
  const banned = policy.deniedComponents.flatMap((d) => (d.cargo ?? []).map((name) => `{ crate = ${q(name)}, reason = ${q(`${d.component}: denied component (licence-policy.json; PG-D31)`)} }`));
  out.push(
    "",
    "[bans]",
    'multiple-versions = "warn"',
    'wildcards = "deny"',
    "# Path dependencies between our own unpublished workspace crates are not wildcards that matter.",
    "allow-wildcard-paths = true",
    "# Codecs whose patent holders or pools license them (PG-D31). The string scan of the shipped",
    "# binaries in the licence job catches what a crate name does not.",
    `deny = ${tomlList(banned)}`,
  );
  for (const f of policy.deniedFeatures) {
    out.push("", `# ${f.reason}`, "[[bans.features]]", `crate = ${q(f.crate)}`, `deny = ${JSON.stringify(f.features)}`);
  }
  out.push(
    "",
    "[sources]",
    'unknown-registry = "deny"',
    'unknown-git = "deny"',
    'allow-registry = ["https://github.com/rust-lang/crates.io-index"]',
    `allow-git = ${JSON.stringify([...new Set([...policy.rust.allow_git, ...policy.ownSources.map((o) => o.source)])])}`,
  );
  return `${out.join("\n")}\n`;
}

function renderAbout(policy) {
  const out = [
    ...header(policy, "#", ["cargo-about 0.9 format (cargo-about 0.9.3). Engineering standard §3.10."]),
    "",
    `# Class L of profile ${policy.profile}, in the policy's order: cargo-about picks the first`,
    "# accepted licence of an OR expression.",
    `accepted = ${tomlList(toolList(policy, "L").map(q))}`,
    `targets = ${JSON.stringify(policy.rust.targets)}`,
    "ignore-build-dependencies = false",
    "ignore-dev-dependencies = true",
    "",
    "[private]",
    "ignore = true",
  ];
  const crates = [...new Set([...policy.classOverrides.filter((o) => o.ecosystem === "cargo").map((o) => o.package), ...policy.clarifications.filter((c) => c.ecosystem === "cargo").map((c) => c.package)])];
  for (const name of crates) {
    const o = policy.classOverrides.find((x) => x.ecosystem === "cargo" && x.package === name);
    const c = policy.clarifications.find((x) => x.ecosystem === "cargo" && x.package === name);
    if (o) out.push("", `# Judged as class ${o.class}: ${o.why}`, `[${key(name)}]`, `accepted = ${tomlList(toolList(policy, o.class).map(q))}`);
    if (c) {
      out.push(
        "",
        `# ${c.evidence} (read ${c.read}; version ${c.version})`,
        `[${key(name)}.clarify]`,
        `license = ${q(c.licence)}`,
        "",
        `[[${key(name)}.clarify.files]]`,
        `path = ${q(c.licence_file.path)}`,
        `checksum = ${q(c.licence_file.sha256)}`,
      );
    }
  }
  for (const o of policy.ownSources) {
    for (const name of o.crates) out.push("", `# Luka's own crate from ${o.source} (own_sources): ${o.why}`, `[${key(name)}]`, `accepted = ${tomlList([q(o.licence)])}`);
  }
  return `${out.join("\n")}\n`;
}

export function purl(ecosystem, name) {
  if (ecosystem === "maven") {
    const [group, artifact] = name.split(":");
    return `pkg:maven/${group}/${artifact}`;
  }
  const type = { cargo: "cargo", npm: "npm", nuget: "nuget", pypi: "pypi" }[ecosystem];
  return `pkg:${type}/${(ecosystem === "pypi" ? lower(name).replace(/[-_.]+/g, "-") : name).replace(/^@/, "%40")}`;
}

function renderDependencyReview(policy) {
  const y = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const list = (k, items, comment) => (items.length ? ["", ...comment.map((c) => `# ${c}`), `${k}:`, ...items.map((x) => `  - ${y(x)}`)] : []);
  const out = [
    ...header(policy, "#", [
      "Read by .github/workflows/dependency-review.yml (config-file). The action fails a pull",
      "request that adds a dependency whose licence is not on allow-licenses; a licence it cannot",
      "detect does not fail it, so the stack CI's licence job (check-licences.mjs, cargo-deny) stays",
      "the gate over the whole tree.",
    ]),
    ...list("allow-licenses", toolList(policy, "L"), [`Class L of profile ${policy.profile}.`]),
    ...list(
      "allow-dependencies-licenses",
      [...policy.classOverrides.map((o) => purl(o.ecosystem, o.package)), ...policy.ownSources.flatMap((o) => o.crates.map((n) => purl(o.ecosystem, n)))],
      [
        "Packages judged as another class (class_overrides); the licence job judges them there.",
        ...(policy.ownSources.length ? ["Luka's own crates from his own repositories (own_sources); cargo-deny admits them by source."] : []),
      ],
    ),
    ...list(
      "deny-packages",
      policy.deniedComponents.flatMap((d) => ECOSYSTEMS.flatMap((e) => (d[e] ?? []).map((n) => purl(e, n)))),
      ["Denied components (PG-D31): codecs whose patent holders or pools license them."],
    ),
    // Not a list helper call: each advisory carries its own reason and review date as a comment above it.
    ...(policy.allowGhsas.length
      ? [
          "",
          "# Advisories this repository accepts (allow_ghsas), each with its reason and the date it is reviewed again.",
          "allow-ghsas:",
          ...policy.allowGhsas.flatMap((g) => [`  # ${g.reason} Review by ${g.until}.`, `  - ${y(g.id)}`]),
        ]
      : []),
  ];
  return `${out.join("\n")}\n`;
}

function renderNugetAllowed(policy) {
  // JSON has no comments, so the header is the first entry; it names no licence.
  const head =
    `Generated by ${GENERATOR} from ${POLICY_PATH} (profile ${policy.profile}). Do not edit: change the policy ` +
    `and run node ${GENERATOR} --write; CI runs it with --check, which fails when this file differs from what ` +
    "the policy generates (PG-D3). nuget-license 4.0 allowed licence types (nuget-license 4.0.18). This first " +
    "entry is the header and names no licence.";
  return `${JSON.stringify([head, ...toolList(policy, "L")], null, 2)}\n`;
}

// nuget-license 4.0's --override-package-information file: a JSON array with one { Id, Version,
// License } object per NuGet clarification (the three required fields of its
// docs/override-package-json.md). The override replaces the licence the package declares, which is
// how a `type="file"` or URL-only package gets its SPDX id. The file is a bare array, so it has no
// header: --check guards it like the others. Sorted by package and version in code-unit order, so the output is
// the same on every machine: localeCompare would follow the machine's default locale (B0-U01).
const byCodeUnit = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
function nugetClarifications(policy) {
  return policy.clarifications
    .filter((c) => c.ecosystem === "nuget")
    .slice()
    .sort((a, b) => byCodeUnit(lower(a.package), lower(b.package)) || byCodeUnit(String(a.version), String(b.version)));
}

function renderNugetOverrides(policy) {
  const entries = nugetClarifications(policy).map((c) => ({ Id: c.package, Version: c.version, License: c.licence }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// A NuGet licence-file pin names the installed file: under the home folder (~/ or ~\, where the global packages folder
// is) or the package's install folder ({path}/...). A path from the repository root is a committed copy, and an
// absolute path is one too, through the checkout's own path, or a file that exists on one machine only.
function installedFilePin(path) {
  return /^(\{path\}|~[\\/])/.test(path);
}

// nuget-license 4.0's --licensefile-to-license-mappings file: a JSON object from a committed licence file to its licence
// id (docs/licensefile-mappings-json.md). It is always the empty object: the only file a NuGet clarification could map is
// a committed copy, and compilePolicy refuses that pin (B0-U13). The workflows pass the file to nuget-license, so it is
// still written and checked.
function renderNugetMappings() {
  return "{}\n";
}

export const RENDERERS = {
  "deny.toml": renderDeny,
  "about.toml": renderAbout,
  ".github/dependency-review-config.yml": renderDependencyReview,
  ".github/nuget-license/allowed-licenses.json": renderNugetAllowed,
  ".github/nuget-license/overrides.json": renderNugetOverrides,
  ".github/nuget-license/licensefile-mappings.json": renderNugetMappings,
};

export function render(policy) {
  return Object.fromEntries(policy.generate.map((f) => [f, RENDERERS[f](policy)]));
}

// ---- command line --------------------------------------------------------------------------

function main() {
  const usage = (m) => {
    console.error(`${m}\nusage: node ${GENERATOR} --write|--check [--policy ${POLICY_PATH}] [--root .]`);
    process.exit(2);
  };
  let values;
  try {
    ({ values } = parseArgs({ options: { write: { type: "boolean" }, check: { type: "boolean" }, policy: { type: "string" }, root: { type: "string", default: "." } } }));
  } catch (e) {
    usage(e.message);
  }
  if (Boolean(values.write) === Boolean(values.check)) usage("give exactly one of --write and --check");
  const root = resolve(values.root);
  let policy;
  try {
    policy = readPolicy(values.policy ? resolve(values.policy) : join(root, POLICY_PATH));
  } catch (e) {
    if (e instanceof PolicyError) usage(e.message);
    throw e;
  }
  if (policy.problems.length) {
    console.error(`The policy carries ${policy.problems.length} licence problem(s); nothing was generated:\n${policy.problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  const files = render(policy);
  if (values.write) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
      console.log(`wrote ${path}`);
    }
    return;
  }
  const drift = [];
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    if (!existsSync(full)) {
      drift.push(`${path} is missing`);
      continue;
    }
    const have = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    if (have === text) continue;
    // The lines of each text, without the empty piece after its final newline, so a reported line is always a line
    // of one of the files: the first that differs; the first past the shorter file when one is the start of the other;
    // or, when only the final newline differs, the last line.
    const a = have.replace(/\n$/, "").split("\n");
    const b = text.replace(/\n$/, "").split("\n");
    let line = 0;
    while (line < a.length && line < b.length && a[line] === b[line]) line++;
    const at = line === a.length && line === b.length ? b.length : line + 1;
    drift.push(`${path} differs from what the policy generates, first at line ${at}`);
  }
  if (drift.length) {
    console.error(`Generated licence configs have drifted from ${POLICY_PATH}:\n${drift.map((d) => `- ${d}`).join("\n")}\nRun node ${GENERATOR} --write and commit the result.`);
    process.exit(1);
  }
  console.log(`${Object.keys(files).length} generated licence config(s) match ${POLICY_PATH} (profile ${policy.profile}).`);
}

// Real paths on both sides: Node gives import.meta.url as the module's real path, so a script path or working folder
// through a junction or symlink would not match the path as typed, and the command would exit 0 having checked nothing
// (B0-U02's inspector 8, N1; B0-U01 round 8).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) main();
