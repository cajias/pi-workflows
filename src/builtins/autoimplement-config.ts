import fs from "node:fs";
import path from "node:path";
import { workflowsConfigDir } from "../state/config-dir.js";
import { parseForgeRequest, type ForgeRequest } from "./autoimplement-forge.js";

/**
 * Persistent Autoimplement defaults.
 *
 * The file `${PI_WORKFLOWS_CONFIG_DIR:-~/.config/pi-workflows}/autoimplement.json` can set `forge`
 * and `prTiming`. Workflow input wins over the file, and the file wins over the built-in defaults.
 * The loader is synchronous because input parsing is synchronous.
 */

export type PrTiming = "early" | "end";
export const AUTOIMPLEMENT_DEFAULTS_SCHEMA = "pi-workflows.autoimplement-defaults.v1";
export const AUTOIMPLEMENT_DEFAULTS_FILE = "autoimplement.json";
export type AutoimplementDefaults = { forge?: ForgeRequest; prTiming?: PrTiming };

const DEFAULTS_KEYS = new Set(["schema", "forge", "prTiming"]);

export function parsePrTiming(value: unknown, label: string): PrTiming | undefined {
  if (value === undefined) return undefined;
  if (value !== "early" && value !== "end") throw new Error(`${label} must be early or end`);
  return value;
}

export function autoimplementDefaultsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(workflowsConfigDir(env), AUTOIMPLEMENT_DEFAULTS_FILE);
}

function defaultsError(file: string, message: string): Error {
  return new Error(`autoimplement defaults file ${file}: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strict: requires `schema`, allows only `schema`, `forge`, and `prTiming`, and names the file in every error. */
export function parseAutoimplementDefaults(value: unknown, file: string): AutoimplementDefaults {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw defaultsError(file, "must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !DEFAULTS_KEYS.has(key));
  if (unknown.length > 0) {
    throw defaultsError(
      file,
      `unknown keys ${unknown.join(", ")}; allowed keys are schema, forge, and prTiming`,
    );
  }
  if (record.schema !== AUTOIMPLEMENT_DEFAULTS_SCHEMA) {
    throw defaultsError(file, `schema must be ${AUTOIMPLEMENT_DEFAULTS_SCHEMA}`);
  }
  let forge: ForgeRequest | undefined;
  let prTiming: PrTiming | undefined;
  try {
    forge = parseForgeRequest(record.forge, "forge");
    prTiming = parsePrTiming(record.prTiming, "prTiming");
  } catch (error) {
    throw defaultsError(file, errorMessage(error));
  }
  return {
    ...(forge === undefined ? {} : { forge }),
    ...(prTiming === undefined ? {} : { prTiming }),
  };
}

/** A missing file returns `{}`. Any other read error, invalid JSON, or invalid value throws. */
export function loadAutoimplementDefaults(
  env: NodeJS.ProcessEnv = process.env,
  readText: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): AutoimplementDefaults {
  const file = autoimplementDefaultsPath(env);
  let text: string;
  try {
    text = readText(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw defaultsError(file, errorMessage(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw defaultsError(file, `invalid JSON: ${errorMessage(error)}`);
  }
  return parseAutoimplementDefaults(parsed, file);
}
