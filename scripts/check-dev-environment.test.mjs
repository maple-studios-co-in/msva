import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./check-dev-environment.mjs", import.meta.url));

function writeCommand(binDirectory, name, output) {
  const commandPath = join(binDirectory, name);
  writeFileSync(commandPath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(commandPath, 0o755);
}

function runCheck(t, { manifest, pnpmVersion = "10.6.4", pythonVersion } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "msva-preflight-"));
  t.after(() => rmSync(fixture, { force: true, recursive: true }));

  writeFileSync(join(fixture, "package.json"), JSON.stringify({ packageManager: "pnpm@10.6.4" }));
  writeFileSync(join(fixture, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const binDirectory = join(fixture, "bin");
  mkdirSync(binDirectory);
  if (pnpmVersion !== null) writeCommand(binDirectory, "pnpm", pnpmVersion);
  if (pythonVersion) writeCommand(binDirectory, "python3", pythonVersion);

  if (manifest) {
    const manifestPath = join(fixture, manifest);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "");
  }

  return execFileSync(process.execPath, [scriptPath], {
    cwd: fixture,
    encoding: "utf8",
    env: { PATH: binDirectory },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runCheckResult(t, options) {
  try {
    return { output: runCheck(t, options), status: 0 };
  } catch (error) {
    return {
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      status: error.status
    };
  }
}

test("passes without a voice-agent Python manifest", (t) => {
  const result = runCheckResult(t);

  assert.equal(result.status, 0);
  assert.match(result.output, /Python 3\.12 not required/);
});

test("accepts Python 3.12 when a voice-agent manifest exists", (t) => {
  const result = runCheckResult(t, {
    manifest: "apps/voice-agent/pyproject.toml",
    pythonVersion: "Python 3.12.8"
  });

  assert.equal(result.status, 0);
  assert.match(result.output, /Python 3\.12\.8 \(required by apps\/voice-agent\)/);
});

test("rejects a non-3.12 Python for a voice-agent manifest", (t) => {
  const result = runCheckResult(t, {
    manifest: "apps/voice-agent/requirements.txt",
    pythonVersion: "Python 3.11.9"
  });

  assert.equal(result.status, 1);
  assert.match(result.output, /requires Python 3\.12/);
});

test("rejects a missing Python for a voice-agent manifest", (t) => {
  const result = runCheckResult(t, { manifest: "apps/voice-agent/Pipfile" });

  assert.equal(result.status, 1);
  assert.match(result.output, /Python 3\.12 is required/);
});

test("rejects a missing pnpm executable", (t) => {
  const result = runCheckResult(t, { pnpmVersion: null });

  assert.equal(result.status, 1);
  assert.match(result.output, /pnpm is not available/);
});
