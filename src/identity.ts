import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IdentityConfig {
  /** Lowercase agent name used in paths, directives, env var prefixes (e.g. "titus") */
  agentName: string;
  /** Display name used in UI and logs (e.g. "Titus") */
  agentNameDisplay: string;
  /** Config directory name under $HOME (e.g. ".titus") */
  configDir: string;
  /** Prefix for console log messages (e.g. "titus") */
  logPrefix: string;
  /** Prefix for systemd service names (e.g. "titus") */
  servicePrefix: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const IDENTITY_PATH = path.join(PROJECT_ROOT, 'identity.json');

function loadIdentity(): IdentityConfig {
  const raw = readFileSync(IDENTITY_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as IdentityConfig;

  const required: (keyof IdentityConfig)[] = [
    'agentName',
    'agentNameDisplay',
    'configDir',
    'logPrefix',
    'servicePrefix',
  ];

  for (const key of required) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new Error(`identity.json: missing or empty field "${key}"`);
    }
  }

  return parsed;
}

/** The loaded identity config — singleton, loaded once at import time. */
export const identity: IdentityConfig = loadIdentity();

/** Absolute path to the project root directory. */
export const projectRoot: string = PROJECT_ROOT;
