import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SystemConfig } from "../config.js";

afterEach(async () => {
  restoreEnv();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("reads mode, cwd and maxStep from the environment", () => {
  const config = new SystemConfig({
    LENA_MODE: "cloud",
    CWD: "/srv/lena",
    MAX_STEP: "50",
  });

  expect(config.mode).toBe("cloud");
  expect(config.cwd).toBe("/srv/lena");
  expect(config.maxStep).toBe(50);
});

test("a missing variable throws naming it", () => {
  expect(() => new SystemConfig({ CWD: "/srv/lena", MAX_STEP: "50" })).toThrow(
    "Environment variable LENA_MODE is not set.",
  );
  expect(
    () => new SystemConfig({ LENA_MODE: "local", MAX_STEP: "50" }),
  ).toThrow("Environment variable CWD is not set.");
  expect(
    () => new SystemConfig({ LENA_MODE: "local", CWD: "/srv/lena" }),
  ).toThrow("Environment variable MAX_STEP is not set.");
});

test("an unknown mode throws with the value it got", () => {
  expect(
    () =>
      new SystemConfig({
        LENA_MODE: "staging",
        CWD: "/srv/lena",
        MAX_STEP: "50",
      }),
  ).toThrow('LENA_MODE must be "local" or "cloud"; got "staging".');
});

test("a relative cwd throws with the value it got", () => {
  expect(
    () => new SystemConfig({ LENA_MODE: "local", CWD: "lena", MAX_STEP: "50" }),
  ).toThrow('CWD must be an absolute path; got "lena".');
});

test("a maxStep that is not a positive integer throws with the value it got", () => {
  for (const value of ["0", "-1", "2.5", "fifty"])
    expect(
      () =>
        new SystemConfig({
          LENA_MODE: "local",
          CWD: "/srv/lena",
          MAX_STEP: value,
        }),
    ).toThrow(`MAX_STEP must be a positive integer; got "${value}".`);
});

test("loadFromEnv reads a .env file when the variables are not already set", async () => {
  clearEnv();
  const envFile = await writeEnvFile(
    "LENA_MODE=local\nCWD=/home/dev/.lena\nMAX_STEP=50\n",
  );

  const config = SystemConfig.loadFromEnv(envFile);

  expect(config.mode).toBe("local");
  expect(config.cwd).toBe("/home/dev/.lena");
});

test("loadFromEnv keeps variables already set over the .env file", async () => {
  clearEnv();
  process.env.LENA_MODE = "cloud";
  const envFile = await writeEnvFile(
    "LENA_MODE=local\nCWD=/home/dev/.lena\nMAX_STEP=50\n",
  );

  expect(SystemConfig.loadFromEnv(envFile).mode).toBe("cloud");
});

test("loadFromEnv without a .env file reads the environment alone", async () => {
  clearEnv();
  process.env.LENA_MODE = "cloud";
  process.env.CWD = "/srv/lena";
  process.env.MAX_STEP = "50";

  const config = SystemConfig.loadFromEnv(
    join(tmpdir(), "no-such-dir", ".env"),
  );

  expect(config.mode).toBe("cloud");
});

const ENV_KEYS = ["LENA_MODE", "CWD", "MAX_STEP"] as const;
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
