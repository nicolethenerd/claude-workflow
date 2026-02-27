import { App } from '@slack/bolt';
import { config } from '../config';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SlackThreadMap } from '../types';

export const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
});

// Post the agent's proposed plan to Slack with Approve / Request Changes buttons.
// Returns the thread timestamp so replies can be associated with this task.
export async function postPlanForApproval(
  channelId: string,
  taskKey: string,
  summary: string,
  plan: string,
): Promise<string> {
  const result = await app.client.chat.postMessage({
    channel: channelId,
    text: `[${taskKey}] Plan ready for approval`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*[${taskKey}]* ${summary}\n\n*Proposed plan:*\n\`\`\`\n${plan}\n\`\`\``,
        },
      },
      {
        type: 'actions',
        block_id: `plan_${taskKey}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            style: 'primary',
            action_id: 'approve_plan',
            value: taskKey,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Request changes' },
            action_id: 'request_changes',
            value: taskKey,
          },
        ],
      },
    ],
  });

  const ts = result.ts ?? '';
  await saveThreadMapping(ts, taskKey);
  return ts;
}

// Post a question from the agent. The user replies in the thread to unblock execution.
export async function postQuestion(channelId: string, taskKey: string, question: string): Promise<string> {
  const result = await app.client.chat.postMessage({
    channel: channelId,
    text: `[${taskKey}] Agent needs input`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*[${taskKey}]* The agent needs your input:\n\n${question}\n\n_Reply in this thread to continue._`,
        },
      },
    ],
  });

  const ts = result.ts ?? '';
  await saveThreadMapping(ts, taskKey);
  return ts;
}

// Post a completion notice, optionally linking to the PR.
export async function postComplete(
  channelId: string,
  taskKey: string,
  summary: string,
  prUrl?: string,
): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    text: `[${taskKey}] Task complete`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *[${taskKey}]* Task complete!\n${summary}${prUrl ? `\n\n<${prUrl}|View Pull Request>` : ''}`,
        },
      },
    ],
  });
}

// Post a reply into an existing thread (used for plan rejection confirmations etc.)
export async function replyInThread(channelId: string, threadTs: string, text: string): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}

// ─── Thread → Task mapping ───────────────────────────────────────────────────

const MAPPING_FILE = path.join(config.workspace.dir, 'slack-threads.json');

export async function getTaskKeyForThread(threadTs: string): Promise<string | null> {
  const map = await loadThreadMapping();
  return map[threadTs] ?? null;
}

async function saveThreadMapping(threadTs: string, taskKey: string): Promise<void> {
  const map = await loadThreadMapping();
  map[threadTs] = taskKey;
  await fs.mkdir(path.dirname(MAPPING_FILE), { recursive: true });
  await fs.writeFile(MAPPING_FILE, JSON.stringify(map, null, 2));
}

async function loadThreadMapping(): Promise<SlackThreadMap> {
  try {
    return JSON.parse(await fs.readFile(MAPPING_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
