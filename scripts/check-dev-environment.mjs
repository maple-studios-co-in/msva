#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const requiredNodeMajor = 22;
let failed = false;

function pass(message) {
  console.log(`✓ ${message}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  failed = true;
}

function commandVersion(command, args = ["--version"]) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (Number.isInteger(nodeMajor) && nodeMajor >= requiredNodeMajor) {
  pass(`Node.js ${process.versions.node} (requires >=${requiredNodeMajor})`);
} else {
  fail(`Node.js ${process.versions.node} is too old; use Node.js >=${requiredNodeMajor}.`);
}

const packageManager = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
const expectedPnpmVersion = packageManager?.match(/^pnpm@(.+)$/)?.[1];
const pnpmVersion = commandVersion("pnpm");
if (pnpmVersion === expectedPnpmVersion) {
  pass(`pnpm ${pnpmVersion}`);
} else if (pnpmVersion && expectedPnpmVersion) {
  fail(`pnpm ${pnpmVersion} is installed; this repository requires pnpm ${expectedPnpmVersion}.`);
} else {
  fail("pnpm is not available. Enable Corepack, then run: corepack enable");
}

const lockfilePath = join(root, "pnpm-lock.yaml");
if (existsSync(lockfilePath)) {
  pass("pnpm-lock.yaml is present");
} else {
  fail("pnpm-lock.yaml is missing; run this check from the repository root.");
}

const pythonManifests = [
  "apps/voice-agent/pyproject.toml",
  "apps/voice-agent/requirements.txt",
  "apps/voice-agent/Pipfile",
  "apps/voice-agent/setup.py",
  "apps/voice-agent/setup.cfg"
];
const pythonRequired = pythonManifests.some((path) => existsSync(join(root, path)));

if (pythonRequired) {
  const pythonVersion = commandVersion("python3");
  if (/^Python 3\.12(?:\.\d+)?(?:\s|$)/.test(pythonVersion ?? "")) {
    pass(`${pythonVersion} (required by apps/voice-agent)`);
  } else if (pythonVersion) {
    fail(`${pythonVersion} is installed; apps/voice-agent requires Python 3.12.`);
  } else {
    fail("Python 3.12 is required because apps/voice-agent declares Python dependencies.");
  }
} else {
  pass("Python 3.12 not required (no apps/voice-agent Python manifest found)");
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("\nEnvironment check passed. Next: pnpm install --frozen-lockfile && pnpm verify");
}
