import * as path from 'path';
import { config } from '../config';
import { app } from '../integrations/slack';
import {
  buildBranchName,
  commitAndPush,
  createBranch,
  createPullRequest,
  prepareRepo,
} from '../integrations/github';
import { runClaude, extractAction } from './claude-cli';

interface PendingContext {
  sessionId: string;
  channelId: string;
  threadTs: string;
  workspaceDir: string;
  repo: string;
  branchKey: string;
  summary: string;
}

// When Claude calls ask_human, we store the session context here keyed by threadTs.
// server.ts calls resolveReply() when the user replies in the thread.
const pendingReplies = new Map<string, PendingContext>();

// Called by server.ts when a thread reply arrives.
// Returns true if a Slack agent was waiting for this reply, false otherwise.
export function resolveReply(threadTs: string, text: string): boolean {
  const ctx = pendingReplies.get(threadTs);
  if (!ctx) return false;
  pendingReplies.delete(threadTs);
  continueSlackAgent(text, ctx).catch(err =>
    console.error(`[SlackAgent:${threadTs}] Resume error:`, err),
  );
  return true;
}

export async function runSlackAgent(
  channelId: string,
  threadTs: string,
  repo: string,
  workspaceDir: string,
  userMessage: string,
): Promise<void> {
  const branchKey = `slack-${threadTs.replace('.', '')}`;
  const summary = userMessage.slice(0, 50);
  const branchName = buildBranchName(branchKey, summary);

  await prepareRepo(workspaceDir);
  await createBranch(workspaceDir, branchName);

  const prompt = buildSlackPrompt(workspaceDir, branchName, repo, userMessage);
  const { response, sessionId } = await runClaude(prompt, { cwd: workspaceDir });

  await dispatchAction(response, sessionId, { sessionId, channelId, threadTs, workspaceDir, repo, branchKey, summary });
}

async function continueSlackAgent(text: string, ctx: PendingContext): Promise<void> {
  const { response, sessionId } = await runClaude(text, {
    cwd: ctx.workspaceDir,
    sessionId: ctx.sessionId,
  });
  await dispatchAction(response, sessionId, { ...ctx, sessionId });
}

async function dispatchAction(
  response: string,
  sessionId: string,
  ctx: PendingContext,
): Promise<void> {
  const action = extractAction(response);
  if (!action?.action) {
    console.log(`[SlackAgent:${ctx.threadTs}] No action found in response`);
    return;
  }

  console.log(`[SlackAgent:${ctx.threadTs}] Action: ${action.action}`);

  switch (action.action) {
    case 'ask_human': {
      pendingReplies.set(ctx.threadTs, { ...ctx, sessionId });
      await app.client.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: ctx.threadTs,
        text: action.question,
      });
      break;
    }

    case 'mark_complete': {
      if (action.pr_title && ctx.repo) {
        const branchName = buildBranchName(ctx.branchKey, ctx.summary);
        await commitAndPush(ctx.workspaceDir, action.pr_title, ctx.repo);
        const prUrl = await createPullRequest(
          ctx.repo,
          action.pr_title,
          action.pr_body ?? '',
          branchName,
        );
        await app.client.chat.postMessage({
          channel: ctx.channelId,
          thread_ts: ctx.threadTs,
          text: `✅ ${action.summary}\n\n<${prUrl}|View Pull Request>`,
        });
      } else {
        await app.client.chat.postMessage({
          channel: ctx.channelId,
          thread_ts: ctx.threadTs,
          text: `✅ ${action.summary ?? 'Done.'}`,
        });
      }
      break;
    }

    case 'finish': {
      await app.client.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: ctx.threadTs,
        text: `✅ ${action.message}`,
      });
      break;
    }

    default:
      console.log(`[SlackAgent:${ctx.threadTs}] Unhandled action: ${action.action}`);
  }
}

function buildSlackPrompt(
  workspaceDir: string,
  branchName: string,
  repo: string,
  userMessage: string,
): string {
  return `\
You are an autonomous software development agent responding to a request posted in Slack.
Workspace: ${workspaceDir} (already checked out on branch ${branchName})
Repository: ${repo}

Use your built-in tools (Bash, Read, Write, Edit, Glob, Grep) to read files, run shell commands, write code, and run tests.

IMPORTANT: Do NOT use any MCP tools, Atlassian, Jira, Slack, or GitHub integrations.
The orchestration layer handles all external service communication — your only job is to write code in the workspace.
Do NOT try to look up Jira issues, post to Slack, or create PRs yourself.

When you need to communicate or pause, end your response with a JSON block:
\`\`\`json
{"action": "ask_human", "question": "your question here"}
\`\`\`

Other valid actions:
\`\`\`json
{"action": "mark_complete", "summary": "what was done", "pr_title": "PR title", "pr_body": "PR description"}
\`\`\`
\`\`\`json
{"action": "finish", "message": "what was done (no PR needed)"}
\`\`\`

Rules:
1. Always start by calling ask_human with your proposed plan and wait for approval before writing any code.
2. Run tests after implementing changes.
3. When finished with code changes, output mark_complete with a PR title and body.
4. If the task requires no code changes, output finish with a summary.

User request: ${userMessage}`;
}
