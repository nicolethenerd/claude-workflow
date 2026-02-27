import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  },
  jira: {
    host: requireEnv('JIRA_HOST'),
    email: requireEnv('JIRA_EMAIL'),
    apiToken: requireEnv('JIRA_API_TOKEN'),
    agentLabel: process.env.JIRA_AGENT_LABEL ?? 'claude-agent',
    blockedLabel: process.env.JIRA_BLOCKED_LABEL ?? 'agent-blocked',
  },
  slack: {
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    appToken: requireEnv('SLACK_APP_TOKEN'),
  },
  github: {
    token: requireEnv('GITHUB_TOKEN'),
  },
  scheduler: {
    workerCronSchedule: process.env.WORKER_CRON_SCHEDULE ?? '0 7-23 * * *',
    timezone: process.env.CRON_TIMEZONE ?? 'America/New_York',
  },
  workspace: {
    dir: process.env.WORKSPACE_DIR ?? `${process.env.HOME}/claude-workflow-workspaces`,
  },
};
