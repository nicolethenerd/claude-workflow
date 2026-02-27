import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../config';
import { app } from '../integrations/slack';
import {
  prepareRepo,
  createBranch,
  commitAndPush,
  createPullRequest,
  buildBranchName,
} from '../integrations/github';

const execAsync = promisify(exec);
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// When the agent calls ask_human, it registers a resolver here and awaits it.
// server.ts calls resolveReply() when the user replies in the thread.
const pendingReplies = new Map<string, (text: string) => void>();

// Called by server.ts when a thread reply arrives.
// Returns true if a Slack agent was waiting for this reply, false otherwise.
export function resolveReply(threadTs: string, text: string): boolean {
  const resolve = pendingReplies.get(threadTs);
  if (!resolve) return false;
  pendingReplies.delete(threadTs);
  resolve(text);
  return true;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'ask_human',
    description:
      'Post a message in the Slack thread and wait for a reply. ' +
      'Use this first to propose your plan and get approval, then again whenever you are blocked.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to post in the thread' },
      },
      required: ['message'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file (path relative to workspace root)',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Directory path (default: ".")' } },
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace directory',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default: 60000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'prepare_repo',
    description: 'Pull latest changes and create a branch. Call before writing any code.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_pull_request',
    description: 'Commit all changes, push the branch, and open a pull request.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'finish',
    description: 'Post a completion summary to the thread and end the session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'What was done' },
      },
      required: ['message'],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

interface SlackAgentContext {
  channelId: string;
  threadTs: string;
  workspaceDir: string;
  repo: string;        // "owner/repo"
  branchKey: string;   // used for branch naming, e.g. "slack-1234567"
  summary: string;     // short description of the task (from user's first message)
}

async function executeTool(
  toolName: string,
  toolInput: Record<string, any>,
  ctx: SlackAgentContext,
): Promise<{ result: string; shouldStop: boolean }> {
  switch (toolName) {
    case 'ask_human': {
      await app.client.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: ctx.threadTs,
        text: toolInput.message as string,
      });
      const reply = await new Promise<string>(resolve =>
        pendingReplies.set(ctx.threadTs, resolve),
      );
      return { result: reply, shouldStop: false };
    }

    case 'read_file': {
      const filePath = resolveSafe(ctx.workspaceDir, toolInput.path as string);
      const content = await fs.readFile(filePath, 'utf-8');
      return { result: content, shouldStop: false };
    }

    case 'write_file': {
      const filePath = resolveSafe(ctx.workspaceDir, toolInput.path as string);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, toolInput.content as string, 'utf-8');
      return { result: `Written: ${toolInput.path}`, shouldStop: false };
    }

    case 'list_directory': {
      const dirPath = resolveSafe(ctx.workspaceDir, (toolInput.path as string) ?? '.');
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const listing = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      return { result: listing || '(empty)', shouldStop: false };
    }

    case 'run_command': {
      const { stdout, stderr } = await execAsync(toolInput.command as string, {
        cwd: ctx.workspaceDir,
        timeout: (toolInput.timeout_ms as number) ?? 60000,
      });
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return { result: output || '(no output)', shouldStop: false };
    }

    case 'prepare_repo': {
      await prepareRepo(ctx.workspaceDir);
      const branchName = buildBranchName(ctx.branchKey, ctx.summary);
      await createBranch(ctx.workspaceDir, branchName);
      return { result: `Repository ready. Branch: ${branchName}`, shouldStop: false };
    }

    case 'create_pull_request': {
      const { title, body } = toolInput as { title: string; body: string };
      const branchName = buildBranchName(ctx.branchKey, ctx.summary);
      await commitAndPush(ctx.workspaceDir, `${title}`, ctx.repo);
      const prUrl = await createPullRequest(ctx.repo, title, body, branchName);
      return { result: `Pull request created: ${prUrl}`, shouldStop: false };
    }

    case 'finish': {
      await app.client.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: ctx.threadTs,
        text: `✅ ${toolInput.message as string}`,
      });
      return { result: 'Done.', shouldStop: true };
    }

    default:
      return { result: `Unknown tool: ${toolName}`, shouldStop: false };
  }
}

// ─── Agent loop ──────────────────────────────────────────────────────────────

export async function runSlackAgent(
  channelId: string,
  threadTs: string,
  repo: string,
  workspaceDir: string,
  userMessage: string,
): Promise<void> {
  const branchKey = `slack-${threadTs.replace('.', '')}`;
  const summary = userMessage.slice(0, 50);

  const ctx: SlackAgentContext = { channelId, threadTs, workspaceDir, repo, branchKey, summary };

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  while (true) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 8096,
      system: buildSystemPrompt(repo, workspaceDir),
      messages,
      tools: TOOL_DEFINITIONS,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      console.log(`[SlackAgent:${threadTs}] Finished (end_turn)`);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let shouldStop = false;

      for (const toolUse of toolUseBlocks) {
        console.log(`[SlackAgent:${threadTs}] Tool: ${toolUse.name}`);
        try {
          const { result, shouldStop: stop } = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, any>,
            ctx,
          );
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
          if (stop) shouldStop = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[SlackAgent:${threadTs}] Tool error (${toolUse.name}): ${msg}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${msg}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      if (shouldStop) break;
    }
  }
}

function buildSystemPrompt(repo: string, workspaceDir: string): string {
  return `\
You are an autonomous software development agent responding to a request posted in Slack.

Repository: ${repo}
Workspace: ${workspaceDir}

Rules:
1. Always start by calling ask_human with your proposed plan and wait for approval before touching any code.
2. Call prepare_repo before making code changes.
3. Run tests after implementing changes.
4. When finished, call create_pull_request then finish with a summary.
5. Use ask_human whenever you need clarification or are blocked.`;
}

function resolveSafe(workspaceDir: string, relativePath: string): string {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(workspaceDir)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}
