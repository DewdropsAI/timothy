import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startBot } from './bot.js';
import { ensureWorkspace } from './workspace.js';
import { identity } from './identity.js';

const REQUIRED_ENV_VARS: { name: string; description: string }[] = [
  { name: 'TELEGRAM_BOT_TOKEN', description: 'Telegram bot token from @BotFather' },
];

/**
 * Load secrets from ~/<configDir>/config.json as fallback when .env is missing.
 * Only sets values that aren't already in process.env.
 */
function loadConfig(): void {
  try {
    const raw = readFileSync(join(homedir(), identity.configDir, 'config.json'), 'utf8');
    const config = JSON.parse(raw) as Record<string, string>;
    for (const [key, value] of Object.entries(config)) {
      if (!process.env[key] && typeof value === 'string') {
        process.env[key] = value;
      }
    }
  } catch {
    // Missing or invalid config — rely on .env / environment
  }
}

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v.name]);
  if (missing.length > 0) {
    console.error('Error: Missing required environment variables:');
    for (const v of missing) {
      console.error(`  - ${v.name}: ${v.description}`);
    }
    console.error(`\nSet them in your .env file or environment, or in ~/${identity.configDir}/config.json.`);
    process.exit(1);
  }
}

loadConfig();
validateEnv();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const isDev = process.argv.includes('watch') || process.env.NODE_ENV === 'development';
const mode = isDev ? 'dev' : 'production';

async function main() {
  console.log(`[${identity.logPrefix}] starting... (mode: ${mode})`);

  await ensureWorkspace();
  console.log(`[${identity.logPrefix}] workspace ready`);

  await startBot(TELEGRAM_BOT_TOKEN);
  console.log(`[${identity.logPrefix}] ready`);
}

main().catch((err) => {
  console.error(`[${identity.logPrefix}] fatal error:`, err);
  process.exit(1);
});
