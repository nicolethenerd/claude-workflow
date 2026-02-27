import { startWorkerCron } from './scheduler/worker-cron';
import { registerSlackHandlers, startSlackApp } from './server';

async function main(): Promise<void> {
  console.log('[Init] Claude Workflow starting...');

  // Register Slack event handlers before connecting
  registerSlackHandlers();

  // Connect to Slack via Socket Mode
  await startSlackApp();

  // Start polling JIRA on the configured cron schedule
  startWorkerCron();

  console.log('[Init] Ready.');
}

main().catch(err => {
  console.error('[Init] Fatal error:', err);
  process.exit(1);
});
