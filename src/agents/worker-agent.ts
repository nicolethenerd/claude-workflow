import * as path from 'path';
import { config } from '../config';
import * as jira from '../integrations/jira';
import * as slack from '../integrations/slack';
import {
  buildBranchName,
  commitAndPush,
  createBranch,
  createPullRequest,
  prepareRepo,
} from '../integrations/github';
import { runClaude, extractAction } from './claude-cli';
import type { JiraTask, JiraComment } from '../types';

// Entry point called by the cron scheduler and server.ts on plan approval / human reply.
// Finds the existing claude session (if any) from Jira comments and resumes it,
// or starts a fresh session for a first run.
export async function runWorkerAgent(task: JiraTask): Promise<void> {
  console.log(`[${task.key}] Starting agent: ${task.summary}`);

  const repoName = task.repository?.split('/')[1] ?? task.key;
  const workspaceDir = path.join(config.workspace.dir, repoName);

  const sessionId = extractSessionId(task.comments);
  const isFirstRun = !sessionId;

  let prompt: string;

  if (isFirstRun) {
    await prepareRepo(workspaceDir);
    const branchName = buildBranchName(task.key, task.summary);
    await createBranch(workspaceDir, branchName);
    prompt = buildInitialPrompt(task, workspaceDir, branchName);
  } else {
    const lastUserReply = extractLastUserReply(task.comments);
    prompt = lastUserReply ?? 'Continue.';
  }

  console.log(`[${task.key}] Running claude (isFirstRun=${isFirstRun}, sessionId=${sessionId ?? 'none'})`);

  const { response, sessionId: newSessionId } = await runClaude(prompt, {
    cwd: workspaceDir,
    sessionId: sessionId ?? undefined,
  });

  const action = extractAction(response);
  if (!action?.action) {
    console.log(`[${task.key}] No action found in response; agent may have finished silently`);
    return;
  }

  console.log(`[${task.key}] Action: ${action.action}`);

  switch (action.action) {
    case 'propose_plan': {
      await jira.addComment(
        task.key,
        `[Agent] session_id: ${newSessionId}\nProposed plan:\n${action.plan}`,
      );
      await jira.setWaitingForInput(task.key);
      await slack.postPlanForApproval(task.slackChannel ?? '', task.key, task.summary, action.plan);
      break;
    }

    case 'ask_human': {
      await jira.addComment(
        task.key,
        `[Agent] session_id: ${newSessionId}\nNeeds input: ${action.question}`,
      );
      await jira.setWaitingForInput(task.key);
      await slack.postQuestion(task.slackChannel ?? '', task.key, action.question);
      break;
    }

    case 'mark_complete': {
      if (action.pr_title && task.repository) {
        const branchName = buildBranchName(task.key, task.summary);
        await commitAndPush(workspaceDir, `${task.key}: ${action.pr_title}`, task.repository);
        const prUrl = await createPullRequest(
          task.repository,
          action.pr_title,
          action.pr_body ?? '',
          branchName,
        );
        await jira.addComment(task.key, `[Agent] PR created: ${prUrl}`);
        await jira.setDone(task.key);
        await slack.postComplete(task.slackChannel ?? '', task.key, action.summary, prUrl);
      } else {
        await jira.setDone(task.key);
        await slack.postComplete(task.slackChannel ?? '', task.key, action.summary);
      }
      break;
    }

    default:
      console.log(`[${task.key}] Unhandled action: ${action.action}`);
  }
}

// Scan comments newest-first for the last "[Agent] session_id: <id>" line.
function extractSessionId(comments: JiraComment[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const match = comments[i].body.match(/\[Agent\] session_id: (\S+)/);
    if (match) return match[1];
  }
  return null;
}

// Find the most recent [User] comment to use as the resume prompt.
function extractLastUserReply(comments: JiraComment[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body;
    if (body.startsWith('[User] ')) {
      return body.slice('[User] '.length);
    }
  }
  return null;
}

function buildInitialPrompt(task: JiraTask, workspaceDir: string, branchName: string): string {
  const historyText =
    task.comments.length > 0
      ? '\n\nWork history for this task:\n' +
        task.comments
          .map(c => `[${c.created}] ${c.author}:\n${c.body}`)
          .join('\n\n---\n\n')
      : '';

  return `\
You are an autonomous software development agent.
Workspace: ${workspaceDir} (already checked out on branch ${branchName})

Use your built-in tools (Bash, Read, Write, Edit, Glob, Grep) to read files, run shell commands, write code, and run tests.

IMPORTANT: Do NOT use any MCP tools, Atlassian, Jira, Slack, or GitHub integrations.
The orchestration layer handles all external service communication — your only job is to write code in the workspace.
Do NOT try to look up Jira issues, post to Slack, or create PRs yourself.

When you need to communicate or pause, end your response with a JSON block:
\`\`\`json
{"action": "propose_plan", "plan": "step-by-step plan here"}
\`\`\`

Other valid actions:
\`\`\`json
{"action": "ask_human", "question": "your question here"}
\`\`\`
\`\`\`json
{"action": "mark_complete", "summary": "what was done", "pr_title": "PR title", "pr_body": "PR description"}
\`\`\`

Rules:
1. Always output propose_plan before writing any code (unless history shows the plan was already approved).
2. After writing code, run the test suite and fix any failures.
3. Use ask_human sparingly — only when genuinely blocked.
4. When implementation is complete and tests pass, output mark_complete with pr_title and pr_body.

Task: ${task.key}: ${task.summary}
${task.description}${historyText}`;
}
