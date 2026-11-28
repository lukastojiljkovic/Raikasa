#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Static-site checks that no off-the-shelf tool makes, run against the built site:
//
// SEO and AEO (every kind)
//   - sitemap.xml lists every page (404.html excepted); a site at the host root
//     also has a robots.txt that names it;
//   - a real 404.html exists;
//   - every page has lang, a title, a meta description, a viewport, an icon, a
//     canonical URL inside the site, and og:title, og:description, og:url and an
//     absolute og:image;
//   - every JSON-LD block parses;
//   - every <img> has alt text (empty is allowed for decoration) and width/height.
// Program rules for product pages (R4)
//   - promo:   SoftwareApplication structured data, a download link to the GitHub
//              release, a "See more apps" link to the portfolio's #apps section
//              (the --portfolio-url option plus #apps; S-16, CV-D55 (a)), and the
//              developer credit linking to the portfolio itself.
//   - portfolio and other: the SEO and AEO checks only.
//
// Usage: node check-site.mjs --root _site --base-url https://<owner>.github.io/<App>/
//        --kind promo|portfolio|other [--portfolio-url URL]
//        (--portfolio-url defaults to https://lukastojiljkovic.github.io/CV/, so a
//        promo page links https://lukastojiljkovic.github.io/CV/#apps for "See more apps")

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "_site" },
    "base-url": { type: "string" },
    kind: { type: "string", default: "promo" },
    "portfolio-url": { type: "string", default: "https://lukastojiljkovic.github.io/CV/" },
  },
});
const KINDS = ["promo", "portfolio", "other"];
if (!values["base-url"] || !KINDS.includes(values.kind)) {
  console.error(`usage: check-site.mjs --root DIR --base-url URL --kind ${KINDS.join("|")}`);
  process.exit(2);
}
const root = values.root;
const base = values["base-url"].endsWith("/") ? values["base-url"] : `${values["base-url"]}/`;
const portfolio = values["portfolio-url"].endsWith("/") ? values["portfolio-url"] : `${values["portfolio-url"]}/`;
const appsUrl = `${portfolio}#apps`;
const problems = [];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
const pages = walk(root)
  .map((f) => relative(root, f).split(sep).join("/"))
  .filter((f) => f.endsWith(".html"));
const urlOf = (p) => base + p.replace(/(^|\/)index\.html$/, "$1");

// Attribute of the first tag matching `selector` (a regex fragment inside the tag).
function attr(html, selector, name) {
  const tag = html.match(new RegExp(`<[^>]*${selector}[^>]*>`, "i"))?.[0];
  if (!tag) return null;
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"))?.slice(2).find((v) => v !== undefined) ?? null;
}

// Site-level files.
if (!pages.includes("index.html")) problems.push("index.html is missing");
if (!pages.includes("404.html")) problems.push("404.html is missing: GitHub Pages serves it for every unknown path, so it must be a real page");
// Crawlers read robots.txt only at the host root (RFC 9309, section 2.3): a project
// site under /<Repo>/ is listed in the user site's root robots.txt instead.
const atRoot = new URL(base).pathname === "/";
const robots = read("robots.txt");
if (!atRoot) console.log(`Note: ${base} is a project site; list ${base}sitemap.xml in the host root's robots.txt.`);
else if (!robots) problems.push("robots.txt is missing");
else if (!robots.split(/\r?\n/).some((l) => l.trim() === `Sitemap: ${base}sitemap.xml`)) problems.push(`robots.txt does not name the sitemap (Sitemap: ${base}sitemap.xml)`);
const sitemap = read("sitemap.xml");
if (!sitemap) problems.push("sitemap.xml is missing");
else {
  const locs = new Set([...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
  for (const p of pages) if (p !== "404.html" && !locs.has(urlOf(p))) problems.push(`sitemap.xml does not list ${urlOf(p)}`);
}

// Every page.
for (const p of pages) {
  const html = read(p);
  const at = (msg) => problems.push(`${p}: ${msg}`);
  if (!/<html\b[^>]*\blang\s*=\s*["'][a-z]{2}/i.test(html)) at("no lang attribute on <html>");
  if (!html.match(/<title>\s*\S[^<]*<\/title>/i)) at("no <title>");
  if (!attr(html, 'name\\s*=\\s*["\']description["\']', "content")?.trim()) at("no meta description");
  if (!attr(html, 'name\\s*=\\s*["\']viewport["\']', "content")) at("no meta viewport");
  if (!attr(html, 'rel\\s*=\\s*["\'][^"\']*icon[^"\']*["\']', "href")) at("no favicon link");
  const canonical = attr(html, 'rel\\s*=\\s*["\']canonical["\']', "href");
  if (!canonical) at("no canonical link");
  else if (!canonical.startsWith(base)) at(`the canonical URL ${canonical} is outside ${base}`);
  for (const og of ["og:title", "og:description", "og:url"]) {
    if (!attr(html, `property\\s*=\\s*["']${og}["']`, "content")?.trim()) at(`no ${og}`);
  }
  const image = attr(html, 'property\\s*=\\s*["\']og:image["\']', "content");
  if (!image) at("no og:image");
  else if (!/^https:\/\//.test(image)) at(`og:image must be an absolute https URL, not ${image}`);

  const types = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const item of [data, ...(data["@graph"] ?? [])].flat()) {
        const t = item?.["@type"];
        types.push(...(Array.isArray(t) ? t : [t]).filter(Boolean));
      }
    } catch (e) {
      at(`JSON-LD does not parse (${e.message})`);
    }
  }

  for (const img of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\balt\s*=/i.test(img)) at(`an <img> has no alt attribute: ${img.slice(0, 80)}`);
    if (!/\bwidth\s*=/i.test(img) || !/\bheight\s*=/i.test(img)) at(`an <img> has no width and height (layout shift): ${img.slice(0, 80)}`);
  }

  if (p === "index.html" && values.kind === "promo") {
    if (!types.includes("SoftwareApplication")) at("no SoftwareApplication structured data (JSON-LD)");
    const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    if (!hrefs.some((h) => /\/releases\/(latest|download\/)/.test(h))) at("no download link to the GitHub release (/releases/latest or /releases/download/)");
    if (!hrefs.includes(appsUrl)) at(`no "See more apps" link to the portfolio's apps section (${appsUrl})`);
    // The credit is judged on the same normalised base as the #apps link; the base without its
    // trailing slash is the same page and passes too.
    if (!hrefs.includes(portfolio) && !hrefs.includes(portfolio.slice(0, -1))) at(`no developer credit linking to the portfolio (${portfolio})`);
  }
}

if (!read("llms.txt")) console.log("Note: no llms.txt (optional; see the engineering standard on AEO).");

const summary = problems.length
  ? `### Site checks: ${problems.length} problem(s)\n\n${problems.map((x) => `- ${x}`).join("\n")}\n`
  : `### Site checks: ${pages.length} page(s), no problems\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(problems.length ? 1 : 0);
