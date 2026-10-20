import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GlobalConfig } from "../config.js";

afterEach(async () => {
  restoreEnv();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("reads mode and cwd from the environment", () => {
  const config = new GlobalConfig({ MODE: "cloud", CWD: "/srv/lena" });

  expect(config.mode).toBe("cloud");
  expect(config.cwd).toBe("/srv/lena");
});

test("a missing variable throws naming it", () => {
  expect(() => new GlobalConfig({ CWD: "/srv/lena" })).toThrow(
    "Environment variable MODE is not set.",
  );
  expect(() => new GlobalConfig({ MODE: "local" })).toThrow(
    "Environment variable CWD is not set.",
  );
});

test("an unknown mode throws with the value it got", () => {
  expect(() => new GlobalConfig({ MODE: "staging", CWD: "/srv/lena" })).toThrow(
    'MODE must be "local" or "cloud"; got "staging".',
  );
});

test("a relative cwd throws with the value it got", () => {
  expect(() => new GlobalConfig({ MODE: "local", CWD: "lena" })).toThrow(
    'CWD must be an absolute path; got "lena".',
  );
});

test("loadFromEnv reads a .env file when the variables are not already set", async () => {
  clearEnv();
  const envFile = await writeEnvFile("MODE=local\nCWD=/home/dev/.lena\n");

  const config = GlobalConfig.loadFromEnv(envFile);

  expect(config.mode).toBe("local");
  expect(config.cwd).toBe("/home/dev/.lena");
});

test("loadFromEnv keeps variables already set over the .env file", async () => {
  clearEnv();
  process.env.MODE = "cloud";
  const envFile = await writeEnvFile("MODE=local\nCWD=/home/dev/.lena\n");

  expect(GlobalConfig.loadFromEnv(envFile).mode).toBe("cloud");
});

test("loadFromEnv without a .env file reads the environment alone", async () => {
  clearEnv();
  process.env.MODE = "cloud";
  process.env.CWD = "/srv/lena";

  const config = GlobalConfig.loadFromEnv(join(tmpdir(), "no-such-dir", ".env"));

  expect(config.mode).toBe("cloud");
});

const ENV_KEYS = ["MODE", "CWD"] as const;
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const tempDirs: string[] = [];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function writeEnvFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lena-config-"));
  tempDirs.push(dir);
  const envFile = join(dir, ".env");
  await writeFile(envFile, contents);
  return envFile;
}
