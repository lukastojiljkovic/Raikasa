// SPDX-License-Identifier: MIT
// Test helpers: build throwaway git repositories with controlled history, so each
// policy script is exercised against real commits rather than against mocks.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const OWNER = { name: "Luka Stojiljkovic", email: "stojiljkovic.d.luka@gmail.com" };

// Git marks the files under .git/objects read-only, and rmSync on Windows stops
// on a read-only file with EPERM in Node 24 (Node 26 does not). So a throwaway
// repository is removed with the plain call first, and, if that is refused, with
// every file made writable and the call repeated. A symbolic link is never
// followed, so no file outside the folder has its mode changed.
export function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeWritable(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeWritable(full);
    else chmodSync(full, 0o666);
  }
}

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "policy-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  return {
    dir,
    write(path, text) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    },
    // Commits with an explicit identity through the environment, so a test can
    // build a history that a policy should accept or refuse.
    commit(message, who = OWNER, committer = who) {
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "--allow-empty", "-m", message], {
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      });
      return git(dir, ["rev-parse", "HEAD"]).trim();
    },
    branch(name) {
      git(dir, ["checkout", "-q", "-b", name]);
    },
    checkout(ref) {
      git(dir, ["checkout", "-q", ref]);
    },
    cleanup() {
      removeTree(dir);
    },
  };
}

export function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

// Runs a policy script the way CI does and returns its exit code and output.
export function run(script, args, cwd, extraEnv = {}) {
  // The outer `node --test` marks its children with NODE_TEST_CONTEXT, and a
  // nested `node --test` (the red-green fixture's own test command) then refuses
  // to run any file. CI never has that variable, so the fixture must not either.
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "", ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

export { OWNER };
