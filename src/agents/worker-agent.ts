import Anthropic from '@anthropic-ai/sdk';
import * as path from 'path';
import * as fs from 'fs/promises';
import { config } from '../config';
import * as jira from '../integrations/jira';
import { TOOL_DEFINITIONS, executeTool } from './tools';
import type { JiraTask, AgentContext } from '../types';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Entry point called by the cron scheduler.
// The agent reads task history from JIRA comments, runs the agentic loop,
// and exits when the task is complete, paused for human input, or paused for plan approval.
export async function runWorkerAgent(task: JiraTask): Promise<void> {
  console.log(`[${task.key}] Starting agent: ${task.summary}`);

  // Work inside the existing local repo (WORKSPACE_DIR/repo-name)
  const repoName = task.repository?.split('/')[1] ?? task.key;
  const workspaceDir = path.join(config.workspace.dir, repoName);

  const context: AgentContext = { task, workspaceDir };

  // Reconstruct history from JIRA comments so the agent has full context
  // whether this is its first run or a resumption after a human reply
  const historyText =
    task.comments.length > 0
      ? '\n\nWork history for this task:\n' +
        task.comments
          .map(c => `[${c.created}] ${c.author}:\n${c.body}`)
          .join('\n\n---\n\n')
      : '';

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        `Work on the following JIRA task:\n\n` +
        `**${task.key}: ${task.summary}**\n\n` +
        `${task.description}` +
        historyText +
        `\n\n` +
        `Start by reviewing the task and any prior history above. ` +
        `If this is your first time working on it, call \`propose_plan\` with a detailed plan before touching any code. ` +
        `If you see "[User] Plan approved" in the history, proceed directly with implementation. ` +
        `If you see a human reply to a previous question, continue from where you left off.`,
    },
  ];

  // Agentic loop
  while (true) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 8096,
      system: buildSystemPrompt(task),
      messages,
      tools: TOOL_DEFINITIONS,
    });

    // Add assistant turn to history
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Claude stopped without calling mark_complete — log and exit
      console.log(`[${task.key}] Agent reached end_turn without explicit completion`);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let shouldStop = false;

      for (const toolUse of toolUseBlocks) {
        console.log(`[${task.key}] Tool: ${toolUse.name}`);

        try {
          const { result, shouldStop: stop } = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, any>,
            context,
          );

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result,
          });

          if (stop) shouldStop = true;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[${task.key}] Tool error (${toolUse.name}): ${errorMsg}`);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });

      if (shouldStop) {
        console.log(`[${task.key}] Agent paused (waiting for human or task complete)`);
        break;
      }
    }
  }
}

function buildSystemPrompt(task: JiraTask): string {
  return `\
You are an autonomous software development agent working on JIRA tasks.

Current task: ${task.key}
Workspace: An isolated directory where you can read/write files and run shell commands.

Rules:
1. Always call \`propose_plan\` before writing any code (unless the history shows the plan was already approved).
2. Call \`prepare_repo\` before making code changes so the repo is cloned and a branch is created.
3. After writing code, run the test suite and fix failures before opening a PR.
4. Use \`ask_human\` sparingly — only when genuinely blocked. Prefer figuring things out yourself.
5. When the implementation is complete and tests pass, call \`create_pull_request\` then \`mark_complete\`.
6. Be concise in your reasoning; be thorough in your code.`;
}
