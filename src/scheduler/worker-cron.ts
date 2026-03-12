import cron from 'node-cron';
import { config } from '../config';
import { getReadyAgentTasks, setInProgress } from '../integrations/jira';
import { runWorkerAgent } from '../agents/worker-agent';

// Tracks tasks currently being processed in this process to avoid re-entrancy
// if a cron tick fires while a previous agent is still running.
const inFlight = new Set<string>();

export function startWorkerCron(): void {
  if (!config.claude.enabled) {
    console.log('[Scheduler] Claude agent disabled — worker cron not started.');
    return;
  }

  console.log(
    `[Scheduler] Worker cron starting. Schedule: ${config.scheduler.workerCronSchedule} (${config.scheduler.timezone})`,
  );

  cron.schedule(
    config.scheduler.workerCronSchedule,
    async () => {
      console.log('[Scheduler] Polling JIRA for ready tasks...');

      let tasks;
      try {
        tasks = await getReadyAgentTasks();
      } catch (err) {
        console.error('[Scheduler] Failed to fetch tasks from JIRA:', err);
        return;
      }

      if (tasks.length === 0) {
        console.log('[Scheduler] No ready tasks found.');
        return;
      }

      console.log(`[Scheduler] Found ${tasks.length} task(s): ${tasks.map(t => t.key).join(', ')}`);

      for (const task of tasks) {
        if (inFlight.has(task.key)) {
          console.log(`[Scheduler] ${task.key} already running in this process, skipping.`);
          continue;
        }

        inFlight.add(task.key);

        // Move to In Progress immediately so other cron ticks skip it
        try {
          await setInProgress(task.key);
        } catch (err) {
          console.error(`[Scheduler] Could not transition ${task.key} to In Progress:`, err);
          inFlight.delete(task.key);
          continue;
        }

        // Run agent asynchronously so multiple tasks can run in parallel
        runWorkerAgent(task)
          .catch(err => console.error(`[${task.key}] Agent error:`, err))
          .finally(() => inFlight.delete(task.key));
      }
    },
    { timezone: config.scheduler.timezone },
  );
}
