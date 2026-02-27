import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type Anthropic from '@anthropic-ai/sdk';
import * as jira from '../integrations/jira';
import * as slack from '../integrations/slack';
import { buildBranchName, commitAndPush, createBranch, createPullRequest, prepareRepo } from '../integrations/github';
import type { AgentContext } from '../types';

const execAsync = promisify(exec);

// ─── Tool definitions (sent to Claude) ──────────────────────────────────────

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'propose_plan',
    description:
      'ALWAYS call this first, before touching any code. Posts your step-by-step plan to Slack for the user to approve. Execution pauses until they approve.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan: { type: 'string', description: 'Detailed step-by-step implementation plan' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file (path relative to the workspace root)',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating it and any parent directories if needed',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories at a path',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root (default: ".")' },
      },
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace directory (e.g. git, npm, tests)',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'prepare_repo',
    description: 'Pull the latest changes and create a branch for this task. Call this before making any code changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'create_pull_request',
    description: 'Commit all changes, push the branch, and open a pull request. Call this when implementation and tests are complete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description (markdown)' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'ask_human',
    description:
      'Post a question to Slack and pause execution. Use this when you are genuinely blocked and cannot proceed without input. Try to solve problems independently first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question to ask the human' },
      },
      required: ['question'],
    },
  },
  {
    name: 'mark_complete',
    description: 'Mark the task as done with a summary. Call this after the PR is open and all work is finished.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was done' },
        pr_url: { type: 'string', description: 'Pull request URL (if one was created)' },
      },
      required: ['summary'],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

export interface ToolOutput {
  result: string;
  // When true the agentic loop should exit after returning this result to Claude
  shouldStop: boolean;
}

export async function executeTool(
  toolName: string,
  toolInput: Record<string, any>,
  context: AgentContext,
): Promise<ToolOutput> {
  const { task, workspaceDir } = context;

  switch (toolName) {
    case 'propose_plan': {
      const { plan } = toolInput as { plan: string };
      await jira.addComment(task.key, `[Agent] Proposed plan:\n${plan}`);
      await jira.setWaitingForInput(task.key);
      await slack.postPlanForApproval(task.slackChannel ?? '', task.key, task.summary, plan);
      return {
        result:
          'Plan posted to Slack for approval. Execution is paused. The task will resume once the plan is approved.',
        shouldStop: true,
      };
    }

    case 'read_file': {
      const filePath = resolveSafe(workspaceDir, toolInput.path as string);
      const content = await fs.readFile(filePath, 'utf-8');
      return { result: content, shouldStop: false };
    }

    case 'write_file': {
      const filePath = resolveSafe(workspaceDir, toolInput.path as string);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, toolInput.content as string, 'utf-8');
      return { result: `Written: ${toolInput.path}`, shouldStop: false };
    }

    case 'list_directory': {
      const dirPath = resolveSafe(workspaceDir, (toolInput.path as string) ?? '.');
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const listing = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      return { result: listing || '(empty)', shouldStop: false };
    }

    case 'run_command': {
      const { stdout, stderr } = await execAsync(toolInput.command as string, {
        cwd: workspaceDir,
        timeout: (toolInput.timeout_ms as number) ?? 60000,
      });
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return { result: output || '(no output)', shouldStop: false };
    }

    case 'prepare_repo': {
      await prepareRepo(workspaceDir);
      const branchName = buildBranchName(task.key, task.summary);
      await createBranch(workspaceDir, branchName);
      return {
        result: `Repository ready at ${workspaceDir}. Branch: ${branchName}`,
        shouldStop: false,
      };
    }

    case 'create_pull_request': {
      const { title, body } = toolInput as { title: string; body: string };
      const repo = task.repository;
      if (!repo) {
        return { result: 'Error: no repository configured for this task.', shouldStop: false };
      }
      const commitMsg = `${task.key}: ${title}`;
      await commitAndPush(workspaceDir, commitMsg, repo);
      const branchName = buildBranchName(task.key, task.summary);
      const prUrl = await createPullRequest(repo, title, body, branchName);
      await jira.addComment(task.key, `[Agent] PR created: ${prUrl}`);
      return { result: `Pull request created: ${prUrl}`, shouldStop: false };
    }

    case 'ask_human': {
      const { question } = toolInput as { question: string };
      await jira.addComment(task.key, `[Agent] Needs input: ${question}`);
      await jira.setWaitingForInput(task.key);
      await slack.postQuestion(task.slackChannel ?? '', task.key, question);
      return {
        result:
          'Question posted to Slack. Execution is paused until the human replies in the thread.',
        shouldStop: true,
      };
    }

    case 'mark_complete': {
      const { summary, pr_url } = toolInput as { summary: string; pr_url?: string };
      await jira.addComment(
        task.key,
        `[Agent] Complete: ${summary}${pr_url ? `\nPR: ${pr_url}` : ''}`,
      );
      await jira.setDone(task.key);
      await slack.postComplete(task.slackChannel ?? '', task.key, summary, pr_url);
      return { result: 'Task marked complete.', shouldStop: true };
    }

    default:
      return { result: `Unknown tool: ${toolName}`, shouldStop: false };
  }
}

// Prevent path traversal — keep all file operations inside the workspace
function resolveSafe(workspaceDir: string, relativePath: string): string {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(workspaceDir)) {
    throw new Error(`Path traversal attempt blocked: ${relativePath}`);
  }
  return resolved;
}
