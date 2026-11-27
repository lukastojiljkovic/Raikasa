// SPDX-License-Identifier: MIT
// The rules job's guard of the docs job's Vale configuration (pr-policy.yml; engineering standard 3.9): .vale.ini
// holds only the keys the template uses, so no key makes Vale skip prose (B0-U02, inspectors 6b and 8), every
// BasedOnStyles names Vale and Microsoft, and no other configuration file at the root is read instead of .vale.ini
// (inspector 8's recheck, N2 and N3). It needs no tools and skips nothing. The docs job's own checks of the Markdown (e-mail autolinks, Vale switches) are
// ../check-docs.mjs, which needs the job's docs-tools install; its tests are in ../test-docs/, which only that job runs.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { valeConfigShadows, valeIniProblems } from "../check-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lines = (text) => valeIniProblems(text).map((p) => p.line);
const BASE = "StylesPath = .vale/styles\nMinAlertLevel = warning\n\n[*.{md,html}]\nBasedOnStyles = Vale, Microsoft\nMicrosoft.Headings = NO\n";

// With a TokenIgnores pattern for e-mail autolinks, Vale 3.26.0 skipped every word between a lone backtick and the
// next autolink of the paragraph (inspector 6b, I6b-1), and BlockIgnores skips whole blocks. SkippedScopes or
// IgnoredScopes at the top made Vale report 0 of 5 planted alerts, and Vale reads `TokenIgnores: ...` as well as
// `TokenIgnores = ...` (inspector 8, I8-2). So the keys are compared with the template's, not with a list of bad ones.
test("a key that is not the template's is refused, written with = or :, at the top or in a section", () => {
  const refused = ["TokenIgnores = (x)", "TokenIgnores: (x)", "  BlockIgnores = (?s)(<x>.*?</x>)", "BlockIgnores:(x)", "SkippedScopes = script, style, pre, figure, p, li", "IgnoredScopes: code, tt, p", "IgnoredClasses = x", "Transform = x.xsl", "junk without a value"];
  for (const line of refused) {
    assert.deepEqual(lines(`${line}\n${BASE}`), [1], `at the top: ${line}`);
    assert.deepEqual(lines(`${BASE}${line}\n`), [7], `in a section: ${line}`);
  }
  // Vale does not read a key in the wrong case; refusing it fails safe.
  assert.deepEqual(lines(`tokenignores = (x)\n${BASE}`), [1]);
  assert.deepEqual(lines(`Microsoft.Headings = NO\n${BASE}`), [1], "a rule switch belongs in a section");
  assert.deepEqual(lines(`${BASE}[formats]\nmdx = md\n`), [8]);
});

test("the template's own keys pass, with = or :, comments, blank lines and a byte-order mark", () => {
  assert.deepEqual(lines(BASE), []);
  assert.deepEqual(lines(`${String.fromCharCode(0xfeff)}# a comment\n; another\nVocab: Program\nPackages = https://example.invalid/Microsoft.zip\n${BASE}Vale.Terms: YES\n`), []);
});

// An empty BasedOnStyles, in the template's section or in a new one for a file, made Vale 3.26.0 report 0 of 3 planted
// alerts (inspector 8, N3; measured 2026-11-26). So every BasedOnStyles must name both of the template's styles.
test("BasedOnStyles names Vale and Microsoft in every section; an empty or shorter list is refused", () => {
  const withStyles = (value) => BASE.replace("BasedOnStyles = Vale, Microsoft", `BasedOnStyles${value}`);
  for (const value of [" =", " = ", ":", " = Vale", " = Microsoft", ": Vale", " = Vale Microsoft", " = vale, microsoft", " = Vale,", " = Microsoft, Microsoft"]) {
    assert.deepEqual(lines(withStyles(value)), [5], `BasedOnStyles${value}`);
  }
  assert.deepEqual(lines(`${BASE}\n[doc.md]\nBasedOnStyles =\n`), [9], "an empty list in a new section");
  assert.deepEqual(lines(`${BASE}\n[doc.md]\nBasedOnStyles = Vale\n`), [9], "a shorter list in a new section");
  for (const value of [" = Vale, Microsoft", ": Vale, Microsoft", " = Vale,Microsoft", " = Microsoft, Vale, write-good", "=Vale , Microsoft "]) {
    assert.deepEqual(lines(withStyles(value)), [], `BasedOnStyles${value}`);
  }
  assert.deepEqual(lines(`${BASE}\n[doc.md]\nBasedOnStyles = Vale, Microsoft\nVale.Terms = YES\n`), []);
});

test(".vale.ini of this repository holds only the template's keys", () => {
  // A repository without .vale.ini fails here: the docs job runs Vale in every repository (standard 3.9).
  const problems = valeIniProblems(readFileSync(join(ROOT, ".vale.ini"), "utf8"));
  assert.deepEqual(problems, [], "switch the rule off around the text instead (<!-- vale Style.Rule = NO --> ... <!-- vale Style.Rule = YES --> on one line)");
});

// Vale 3.26.0, run from the root as the docs job and ci-site.yml run it, read a vale.ini, _vale or .vale file there
// instead of .vale.ini: with Vale.Spelling = NO in it, 0 of 3 planted alerts (inspector 8, N2; measured 2026-11-26).
test("another Vale configuration file at the root is refused; the .vale folder of styles is not one", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-gate-"));
  try {
    writeFileSync(join(dir, ".vale.ini"), BASE);
    mkdirSync(join(dir, ".vale"));
    assert.deepEqual(valeConfigShadows(dir), [], "the template's own layout");
    for (const name of ["vale.ini", "_vale", "_vale.ini", "VALE.INI"]) {
      writeFileSync(join(dir, name), BASE);
      assert.deepEqual(valeConfigShadows(dir), [name], name);
      rmSync(join(dir, name));
    }
    mkdirSync(join(dir, "_vale"));
    assert.deepEqual(valeConfigShadows(dir), ["_vale"], "a _vale folder");
    rmSync(join(dir, "_vale"), { recursive: true });
    rmSync(join(dir, ".vale"), { recursive: true });
    writeFileSync(join(dir, ".vale"), BASE);
    assert.deepEqual(valeConfigShadows(dir), [".vale"], "a .vale file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Vale reads no other configuration file at the root of this repository", () => {
  assert.deepEqual(valeConfigShadows(ROOT), [], "Vale reads such a file instead of .vale.ini: remove it, and keep the configuration in .vale.ini");
});
