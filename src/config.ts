import { resolve } from 'node:path';
import { z } from 'zod';

const csvSchema = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const ConfigSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),

  ALLOWED_USERS: csvSchema,
  ALLOWED_REPOS: csvSchema,

  OPENCODE_BIN: z.string().min(1),
  DEFAULT_REPO: z.string().min(1),
  DEFAULT_AGENT: z.string().min(1).default('general'),

  DATA_DIR: z
    .string()
    .min(1)
    .default('./data')
    .transform((s) => resolve(s)),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MAX_COST_PER_SESSION_USD: z.coerce.number().positive().default(1.0),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    console.error('Config validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    process.exit(1);
  }

  const cfg = result.data;
  if (!cfg.ALLOWED_REPOS.includes(cfg.DEFAULT_REPO)) {
    console.error(
      `DEFAULT_REPO (${cfg.DEFAULT_REPO}) must be present in ALLOWED_REPOS`,
    );
    process.exit(1);
  }
  if (cfg.ALLOWED_USERS.length === 0) {
    console.error('ALLOWED_USERS must list at least one Slack user ID');
    process.exit(1);
  }
  return cfg;
}
