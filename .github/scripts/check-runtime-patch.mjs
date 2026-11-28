#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The self-contained build bundles one .NET runtime. A security patch of the runtime reaches
// the users only when a new release bundles it, so a release whose runtime is not the newest
// patch of its channel does not ship.
//
// The bundled version is read from one of:
//   --deps <App.deps.json>             the publish folder's dependency file, whose
//                                      "runtimepack.Microsoft.NETCore.App.Runtime.<rid>/<version>"
//                                      library names the runtime pack that was copied;
//   --assets <project.assets.json>     the restore result, whose download dependencies name the
//                                      runtime pack that a self-contained publish will copy.
// The newest patch is "latest-runtime" of Microsoft's release metadata for the channel
// (https://builds.dotnet.microsoft.com/dotnet/release-metadata/<channel>/releases.json), or of
// the file or URL given with --index.
//
// Usage: node check-runtime-patch.mjs (--deps <file> | --assets <file>)
//        [--channel 10.0] [--rid win-x64] [--index <file or URL>]
// Exit codes: 0 the bundled runtime is the newest patch; 1 it is not; 2 an input is missing or unreadable.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    deps: { type: "string" },
    assets: { type: "string" },
    channel: { type: "string", default: "10.0" },
    rid: { type: "string", default: "win-x64" },
    index: { type: "string" },
  },
});

function fail(code, message) {
  console.error(`check-runtime-patch: ${message}`);
  process.exit(code);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    return fail(2, `cannot read ${path}: ${err.message}`);
  }
}

if (Boolean(values.deps) === Boolean(values.assets)) fail(2, "give exactly one of --deps and --assets");

const pack = `Microsoft.NETCore.App.Runtime.${values.rid}`;
let bundled;
if (values.deps) {
  const prefix = `runtimepack.${pack}/`;
  const names = Object.keys(readJson(values.deps).libraries ?? {}).filter((name) => name.startsWith(prefix));
  if (names.length !== 1) fail(2, `${values.deps} lists ${names.length} libraries named ${prefix}<version>, expected one`);
  bundled = names[0].slice(prefix.length);
} else {
  const frameworks = Object.values(readJson(values.assets).project?.frameworks ?? {});
  const versions = new Set();
  for (const framework of frameworks) {
    for (const dependency of framework.downloadDependencies ?? []) {
      if (dependency.name === pack) versions.add(String(dependency.version).replace(/^[[(]\s*/, "").split(",")[0].trim());
    }
  }
  if (versions.size !== 1) fail(2, `${values.assets} names ${versions.size} versions of ${pack}, expected one`);
  bundled = [...versions][0];
}

async function readIndex() {
  const source = values.index ?? `https://builds.dotnet.microsoft.com/dotnet/release-metadata/${values.channel}/releases.json`;
  if (!/^https?:\/\//.test(source)) return readJson(source);
  try {
    const response = await fetch(source);
    if (!response.ok) return fail(2, `${source} answered ${response.status}`);
    return await response.json();
  } catch (err) {
    return fail(2, `cannot read ${source}: ${err.message}`);
  }
}

const index = await readIndex();
const latest = index["latest-runtime"];
if (typeof latest !== "string" || !/^\d+\.\d+\.\d+$/.test(latest)) fail(2, "the release metadata has no latest-runtime version");
if (!latest.startsWith(`${values.channel}.`)) fail(2, `latest-runtime ${latest} is not in channel ${values.channel}`);

if (bundled === latest) {
  console.log(`check-runtime-patch: the bundled runtime ${bundled} is the newest ${values.channel} patch.`);
} else {
  console.error(
    `check-runtime-patch: the bundled runtime is ${bundled}, the newest ${values.channel} patch is ${latest}` +
      (typeof index["latest-sdk"] === "string" ? ` (SDK ${index["latest-sdk"]})` : "") +
      ". Move global.json to the SDK that ships it, or set RuntimeFrameworkVersion, then publish again.",
  );
  process.exit(1);
}
