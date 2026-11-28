// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SCRIPTS, run } from "./helpers.mjs";

const BASE = "https://example.github.io/App/";
const PORTFOLIO = "https://example.github.io/CV/";
const APPS = `${PORTFOLIO}#apps`;

function page({ path = "", title = "App", extraHead = "", body = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="App does one thing well.">
<link rel="canonical" href="${BASE}${path}">
<link rel="icon" href="favicon.svg">
<meta property="og:title" content="${title}">
<meta property="og:description" content="App does one thing well.">
<meta property="og:image" content="${BASE}og.png">
<meta property="og:url" content="${BASE}${path}">
${extraHead}
</head>
<body>${body}</body>
</html>
`;
}

const LD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"App","operatingSystem":"Windows","applicationCategory":"UtilitiesApplication"}</script>`;
const PROMO_BODY = `<a href="https://github.com/example/App/releases/latest">Download</a>
<section id="more-apps"><a href="${APPS}">See more apps</a></section>
<footer>Made by <a href="${PORTFOLIO}">Example</a></footer>
<img src="shot.png" alt="The main window" width="800" height="500">`;

const GOOD = {
  "index.html": page({ extraHead: LD, body: PROMO_BODY }),
  "changelog/index.html": page({ path: "changelog/", title: "Changelog" }),
  "404.html": page({ path: "404.html", title: "Not found" }),
  "robots.txt": `User-agent: *\nAllow: /\nSitemap: ${BASE}sitemap.xml\n`,
  "sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${BASE}</loc></url>
<url><loc>${BASE}changelog/</loc></url>
</urlset>
`,
};

function check(files, kind = "promo", base = BASE, portfolio = PORTFOLIO) {
  const dir = mkdtempSync(join(tmpdir(), "site-test-"));
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const r = run(
    "check-site.mjs",
    ["--root", dir, "--base-url", base, "--kind", kind, "--portfolio-url", portfolio],
    dir,
  );
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test("a complete promo site passes", () => {
  const r = check(GOOD);
  assert.equal(r.code, 0, r.out);
});

test("a page missing from the sitemap fails", () => {
  const r = check({ ...GOOD, "privacy/index.html": page({ path: "privacy/", title: "Privacy" }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /privacy\//);
});

// Crawlers read robots.txt only at the host root (RFC 9309, section 2.3), so only a
// site served from the root is asked for one; a project site's sitemap is listed in
// the root robots.txt of the user site (promo-site-standard.md) instead.
const ROOT = "https://example.github.io/";
const asRoot = (files) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : v.replaceAll(BASE, ROOT)]));

test("a site at the host root passes with a robots.txt that names its sitemap", () => {
  const r = check(asRoot(GOOD), "promo", ROOT);
  assert.equal(r.code, 0, r.out);
});

test("a site at the host root must have robots.txt pointing at the sitemap", () => {
  const r = check({ ...asRoot(GOOD), "robots.txt": "User-agent: *\nAllow: /\n" }, "promo", ROOT);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /robots\.txt/);
});

test("a project site needs no robots.txt of its own", () => {
  const r = check({ ...GOOD, "robots.txt": null });
  assert.equal(r.code, 0, r.out);
});

test("a real 404 page is required", () => {
  const r = check({ ...GOOD, "404.html": null });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /404/);
});

test("a page without a description fails", () => {
  const r = check({ ...GOOD, "changelog/index.html": GOOD["changelog/index.html"].replace(/<meta name="description"[^>]*>/, "") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /description/);
});

test("a relative og:image fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace(`${BASE}og.png`, "og.png") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /og:image/);
});

test("a canonical URL outside the site fails", () => {
  const r = check({ ...GOOD, "changelog/index.html": GOOD["changelog/index.html"].replace(`href="${BASE}changelog/"`, 'href="https://elsewhere.example/"') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /canonical/);
});

test("structured data that does not parse fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace('"name":"App",', '"name":"App",,') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /JSON-LD/);
});

test("a promo page needs SoftwareApplication structured data", () => {
  const r = check({ ...GOOD, "index.html": page({ body: PROMO_BODY }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SoftwareApplication/);
});

// "See more apps" links the portfolio's #apps section (S-16, CV-D55 (a)).
test("a promo page without the See more apps link to the portfolio's #apps fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace(APPS, "https://example.github.io/Other/") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /See more apps/);
  assert.match(r.out, /#apps/);
});

test("a promo page whose See more apps link omits #apps fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace(APPS, PORTFOLIO) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /See more apps/);
});

test("a promo page with the #apps link passes", () => {
  const r = check(GOOD);
  assert.equal(r.code, 0, r.out);
});

test("a promo page without the developer credit fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace(`href="${PORTFOLIO}"`, 'href="https://example.com/"') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /developer credit/);
});

// The #apps link and the credit share one normalised base, so a --portfolio-url without its
// trailing slash still accepts a page linking <url>/ and <url>/#apps.
test("a --portfolio-url without a trailing slash accepts the credit and the #apps link on <url>/", () => {
  const r = check(GOOD, "promo", BASE, PORTFOLIO.slice(0, -1));
  assert.equal(r.code, 0, r.out);
});

test("a promo page without a download link fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace("/releases/latest", "/issues") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /download/i);
});

test("an image without alt text or dimensions fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace(' alt="The main window" width="800" height="500"', "") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /img/);
});

test("a portfolio page needs no See more apps link", () => {
  const r = check({ ...GOOD, "index.html": page({ body: '<img src="shot.png" alt="A project" width="800" height="500">' }) }, "portfolio");
  assert.equal(r.code, 0, r.out);
});

test("an unknown kind is rejected", () => {
  const r = check(GOOD, "launcher");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /usage/);
});

test("an image with alt text but no width fails", () => {
  const r = check({ ...GOOD, "index.html": GOOD["index.html"].replace(' width="800"', "") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /width and height/);
});

test("a page without a language fails", () => {
  const r = check({ ...GOOD, "changelog/index.html": GOOD["changelog/index.html"].replace('<html lang="en">', "<html>") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lang/);
});

// assemble-site.sh builds _site/ for ci-site.yml and pages.yml (B0-U01). It needs bash, which the Ubuntu
// runners have; a machine whose `bash` does not run (no Git Bash, a WSL without a distribution) skips the case.
const bashProbe = spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
const HAS_BASH = bashProbe.status === 0 && bashProbe.stdout.trim() !== "";

function assemble(files) {
  const dir = mkdtempSync(join(tmpdir(), "assemble-site-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    copyFileSync(join(SCRIPTS, "assemble-site.sh"), join(dir, "assemble-site.sh"));
    const r = spawnSync("bash", ["assemble-site.sh"], { cwd: dir, encoding: "utf8" });
    const built = readdirSync(join(dir, "_site"), { recursive: true })
      .map((p) => p.replaceAll("\\", "/"))
      .filter((p) => statSync(join(dir, "_site", p)).isFile())
      .sort();
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, built };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("assemble-site.sh puts docs/images beside site/images in _site/images and never nests it", { skip: HAS_BASH ? false : "bash is not available" }, () => {
  const both = assemble({ "site/index.html": "<!doctype html>\n", "site/images/logo.png": "l", "docs/images/shot.png": "s" });
  assert.equal(both.code, 0, both.out);
  assert.deepEqual(both.built, ["images/logo.png", "images/shot.png", "index.html"], "site/images and docs/images merge; docs/images does not become _site/images/images");
  const only = assemble({ "site/index.html": "<!doctype html>\n", "docs/images/shot.png": "s" });
  assert.equal(only.code, 0, only.out);
  assert.deepEqual(only.built, ["images/shot.png", "index.html"], "docs/images alone becomes _site/images");
  const none = assemble({ "site/index.html": "<!doctype html>\n" });
  assert.equal(none.code, 0, none.out);
  assert.deepEqual(none.built, ["index.html"], "no docs/images, nothing added");
});
