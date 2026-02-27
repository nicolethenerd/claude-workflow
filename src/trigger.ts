// Manually triggers one worker poll cycle — useful for testing without waiting for the cron.
// Usage: npm run trigger

import { getReadyAgentTasks, setInProgress } from './integrations/jira';
import { runWorkerAgent } from './agents/worker-agent';
import { registerSlackHandlers, startSlackApp } from './server';
import { config } from './config';

async function main(): Promise<void> {
  // Start the Slack listener so button clicks and thread replies work during testing
  registerSlackHandlers();
  await startSlackApp();

  console.log('[Trigger] Polling JIRA for ready tasks...');

  const tasks = await getReadyAgentTasks();

  if (tasks.length === 0) {
    console.log(`[Trigger] No ready tasks found. Make sure a task has the "${config.jira.agentLabel}" label and status "To Do".`);
    return;
  }

  console.log(`[Trigger] Found ${tasks.length} task(s): ${tasks.map(t => t.key).join(', ')}`);

  for (const task of tasks) {
    console.log(`[Trigger] Starting agent for ${task.key}: ${task.summary}`);
    await setInProgress(task.key);
    await runWorkerAgent(task);
  }

  console.log('[Trigger] Done. Keeping Slack connection open to handle button clicks and replies. Ctrl+C to exit.');
  // Process stays alive so the Slack socket can receive interactions
}

main().catch(err => {
  console.error('[Trigger] Error:', err);
  process.exit(1);
});
