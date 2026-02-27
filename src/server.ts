import { app } from './integrations/slack';
import * as jira from './integrations/jira';
import * as slack from './integrations/slack';
import { runWorkerAgent } from './agents/worker-agent';

function resumeAgent(taskKey: string): void {
  jira.getTaskByKey(taskKey)
    .then(task => runWorkerAgent(task))
    .catch(err => console.error(`[${taskKey}] Error resuming agent:`, err));
}

export function registerSlackHandlers(): void {
  // ── Plan approval buttons ────────────────────────────────────────────────

  app.action('approve_plan', async ({ ack, body }) => {
    await ack();

    const taskKey = (body as any).actions?.[0]?.value as string;
    const channelId = (body as any).channel?.id as string;
    if (!taskKey || !channelId) return;

    console.log(`[Slack] Plan approved for ${taskKey}`);

    await jira.addComment(taskKey, '[User] Plan approved. Proceeding with implementation.');
    await jira.clearWaitingForInput(taskKey);

    // Replace the approval buttons with a confirmation so the message
    // doesn't stay interactive after the decision is made.
    await app.client.chat.update({
      channel: channelId,
      ts: (body as any).message?.ts,
      text: `✅ Plan approved for *${taskKey}*`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ Plan approved for *${taskKey}*. Agent is starting now.` },
        },
      ],
    });

    resumeAgent(taskKey);
  });

  app.action('request_changes', async ({ ack, body }) => {
    await ack();

    const taskKey = (body as any).actions?.[0]?.value as string;
    const channelId = (body as any).channel?.id as string;
    if (!taskKey || !channelId) return;

    const threadTs = (body as any).message?.ts as string;

    console.log(`[Slack] Changes requested for ${taskKey}`);

    // Ask the user to type their feedback in the thread; it will be picked up
    // by the message handler below and added to JIRA.
    await slack.replyInThread(
      channelId,
      threadTs,
      `Please describe what you'd like changed. Your reply in this thread will be sent to the agent.`,
    );
  });

  // ── Thread replies ───────────────────────────────────────────────────────
  // Captures any reply in a thread we're tracking and routes it to JIRA.

  app.message(async ({ message }) => {
    const msg = message as any;

    // Only care about threaded replies (thread_ts differs from ts)
    if (!msg.thread_ts || msg.thread_ts === msg.ts) return;
    // Ignore bot messages
    if (msg.bot_id) return;

    const taskKey = await slack.getTaskKeyForThread(msg.thread_ts);
    if (!taskKey) return;

    const text = (msg.text as string) ?? '';
    console.log(`[Slack] Thread reply for ${taskKey}: ${text}`);

    // Add reply as a JIRA comment and unblock the task
    await jira.addComment(taskKey, `[User] ${text}`);
    await jira.clearWaitingForInput(taskKey);

    await app.client.chat.postMessage({
      channel: msg.channel,
      thread_ts: msg.thread_ts,
      text: `Got it. Resuming *${taskKey}* now.`,
    });

    resumeAgent(taskKey);
  });
}

export async function startSlackApp(): Promise<void> {
  await app.start();
  console.log('[Slack] App connected via Socket Mode');
}
