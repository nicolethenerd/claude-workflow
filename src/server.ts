import * as path from 'path';
import { app } from './integrations/slack';
import * as jira from './integrations/jira';
import * as slack from './integrations/slack';
import { loadProjects } from './integrations/jira';
import { runWorkerAgent } from './agents/worker-agent';
import { runSlackAgent, resolveReply } from './agents/slack-agent';
import { config } from './config';

function resumeJiraAgent(taskKey: string): void {
  jira.getTaskByKey(taskKey)
    .then(task => runWorkerAgent(task))
    .catch(err => console.error(`[${taskKey}] Error resuming agent:`, err));
}

export function registerSlackHandlers(): void {
  // ── Plan approval buttons (JIRA tasks) ──────────────────────────────────

  if (!config.claude.enabled) {
    console.log('[Slack] Claude agent disabled — skipping agent handlers (/work, approve_plan, request_changes, messages)');
  }

  if (config.claude.enabled) app.action('approve_plan', async ({ ack, body }) => {
    await ack();

    const taskKey = (body as any).actions?.[0]?.value as string;
    const channelId = (body as any).channel?.id as string;
    if (!taskKey || !channelId) return;

    console.log(`[Slack] Plan approved for ${taskKey}`);

    await jira.addComment(taskKey, '[User] Plan approved. Proceeding with implementation.');
    await jira.clearWaitingForInput(taskKey);

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

    resumeJiraAgent(taskKey);
  });

  if (config.claude.enabled) app.action('request_changes', async ({ ack, body }) => {
    await ack();

    const taskKey = (body as any).actions?.[0]?.value as string;
    const channelId = (body as any).channel?.id as string;
    if (!taskKey || !channelId) return;

    const threadTs = (body as any).message?.ts as string;

    console.log(`[Slack] Changes requested for ${taskKey}`);

    await slack.replyInThread(
      channelId,
      threadTs,
      `Please describe what you'd like changed. Your reply in this thread will be sent to the agent.`,
    );
  });

  // ── /task slash command ──────────────────────────────────────────────────

  app.command('/task', async ({ command, ack, respond }) => {
    await ack();

    const summary = command.text.trim();
    if (!summary) {
      await respond('Usage: `/task <description>`');
      return;
    }

    const projects = await loadProjects().catch(() => []);
    const project = projects.find(p => p.slackChannel === command.channel_id);

    if (!project) {
      await respond('This channel is not linked to a JIRA project. Add it to `projects.json`.');
      return;
    }

    const labels = config.claude.enabled ? [config.jira.agentLabel] : [];
    const { key } = await jira.createTask(project.key, summary, labels);
    const agentNote = config.claude.enabled ? `\nLabelled \`${config.jira.agentLabel}\` — the agent will pick it up on the next cycle.` : '';
    await respond(`Created *${key}*: ${summary}${agentNote}`);
  });

  // ── /work slash command ──────────────────────────────────────────────────

  if (config.claude.enabled) app.command('/work', async ({ command, ack, respond }) => {
    await ack();

    const ticketKey = command.text.trim().toUpperCase();
    if (!ticketKey || !/^[A-Z]+-\d+$/.test(ticketKey)) {
      await respond('Usage: `/work <TICKET-KEY>` — e.g. `/work KIOSK-7`');
      return;
    }

    const projects = await loadProjects().catch(() => []);
    const project = projects.find(p => p.slackChannel === command.channel_id);
    if (!project) {
      await respond('This channel is not linked to a project. Add it to `projects.json`.');
      return;
    }

    let task: Awaited<ReturnType<typeof jira.getTaskByKey>>;
    try {
      task = await jira.getTaskByKey(ticketKey);
    } catch {
      await respond(`Could not fetch *${ticketKey}*. Make sure it exists and is accessible.`);
      return;
    }

    // Post a message to anchor the thread, then start the agent inside it
    const result = await app.client.chat.postMessage({
      channel: command.channel_id,
      text: `Starting work on *${ticketKey}*: ${task.summary}`,
    });
    const threadTs = result.ts!;

    const repoName = project.repo.split('/')[1];
    const workspaceDir = path.join(config.workspace.dir, repoName);

    const historyText =
      task.comments.length > 0
        ? '\n\nTicket comments:\n' +
          task.comments.map(c => `[${c.created}] ${c.author}:\n${c.body}`).join('\n\n---\n\n')
        : '';

    const userMessage =
      `Jira ticket ${task.key}: ${task.summary}\n\n` +
      `Status: ${task.status}\n\n` +
      `Description:\n${task.description}` +
      historyText;

    console.log(`[Slack] /work ${ticketKey} → thread ${threadTs}`);

    runSlackAgent(command.channel_id, threadTs, project.repo, workspaceDir, userMessage)
      .catch(err => console.error(`[SlackAgent:${ticketKey}] Error:`, err));
  });

  // ── Messages ─────────────────────────────────────────────────────────────

  if (config.claude.enabled) app.message(async ({ message }) => {
    const msg = message as any;
    if (msg.bot_id) return;

    const isThreadReply = msg.thread_ts && msg.thread_ts !== msg.ts;

    if (isThreadReply) {
      // ── Thread reply ────────────────────────────────────────────────────
      // 1. Check if a Slack-initiated agent is waiting for this reply
      const text = (msg.text as string) ?? '';
      if (resolveReply(msg.thread_ts, text)) {
        console.log(`[Slack] Routed reply to waiting agent (thread: ${msg.thread_ts})`);
        return;
      }

      // 2. Otherwise treat as a reply to a JIRA-tracked thread
      const taskKey = await slack.getTaskKeyForThread(msg.thread_ts);
      if (!taskKey) return;

      console.log(`[Slack] Thread reply for ${taskKey}: ${text}`);

      await jira.addComment(taskKey, `[User] ${text}`);
      await jira.clearWaitingForInput(taskKey);

      await app.client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.thread_ts,
        text: `Got it. Resuming *${taskKey}* now.`,
      });

      resumeJiraAgent(taskKey);
    } else {
      // ── Top-level message in a project channel → start a Slack agent ───
      const projects = await loadProjects().catch(() => []);
      const project = projects.find(p => p.slackChannel === msg.channel);
      if (!project) return;

      const text = (msg.text as string) ?? '';
      if (!text.trim()) return;

      console.log(`[Slack] New task in #${project.key}: ${text}`);

      const repoName = project.repo.split('/')[1];
      const workspaceDir = path.join(config.workspace.dir, repoName);

      runSlackAgent(msg.channel, msg.ts, project.repo, workspaceDir, text)
        .catch(err => console.error(`[SlackAgent] Error:`, err));
    }
  });
}

export async function startSlackApp(): Promise<void> {
  await app.start();
  console.log('[Slack] App connected via Socket Mode');
}
