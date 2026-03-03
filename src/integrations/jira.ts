import { Version3Client } from 'jira.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import type { JiraTask, JiraComment, ProjectConfig } from '../types';

const PROJECTS_FILE = path.join(process.cwd(), 'projects.json');

export async function loadProjects(): Promise<ProjectConfig[]> {
  const raw = await fs.readFile(PROJECTS_FILE, 'utf-8');
  const projects: ProjectConfig[] = JSON.parse(raw);
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(`${PROJECTS_FILE} must be a non-empty array of project configs`);
  }
  return projects;
}

const client = new Version3Client({
  host: config.jira.host,
  authentication: {
    basic: {
      email: config.jira.email,
      apiToken: config.jira.apiToken,
    },
  },
});

// Returns tasks labelled for agent pickup that are not currently blocked or in-flight.
// "In Progress" tasks are skipped to prevent two cron cycles picking up the same task.
// Projects are read fresh from projects.json on every call so changes take effect
// without restarting the process.
export async function getReadyAgentTasks(): Promise<JiraTask[]> {
  const projects = await loadProjects();
  const configByKey = Object.fromEntries(projects.map(p => [p.key, p]));
  const projectList = projects.map(p => `"${p.key}"`).join(', ');

  const jql = [
    `project in (${projectList})`,
    `status in ("To Do", "In Progress")`,
    `labels = "${config.jira.agentLabel}"`,
    `labels != "${config.jira.blockedLabel}"`,
  ].join(' AND ') + ' ORDER BY priority DESC';

  const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
    jql,
    fields: ['summary', 'description', 'status', 'labels', 'comment'],
    maxResults: 10,
  });

  return (result.issues ?? []).map(issue => parseIssue(issue, configByKey));
}

export async function getTaskByKey(key: string): Promise<JiraTask> {
  const projects = await loadProjects();
  const configByKey = Object.fromEntries(projects.map(p => [p.key, p]));
  const issue = await client.issues.getIssue({
    issueIdOrKey: key,
    fields: ['summary', 'description', 'status', 'labels', 'comment'],
  });
  return parseIssue(issue, configByKey);
}

export async function createTask(projectKey: string, summary: string): Promise<{ key: string }> {
  const issue = await client.issues.createIssue({
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: 'Task' },
      labels: [config.jira.agentLabel],
    },
  });
  return { key: issue.key ?? '' };
}

export async function setInProgress(taskKey: string): Promise<void> {
  await transitionTo(taskKey, 'In Progress');
}

export async function setDone(taskKey: string): Promise<void> {
  await transitionTo(taskKey, 'Done');
}

// Adds the blocked label without changing the status transition.
// The cron job uses the label to skip tasks awaiting human reply.
export async function setWaitingForInput(taskKey: string): Promise<void> {
  await addLabel(taskKey, config.jira.blockedLabel);
}

// Removes the blocked label so the next cron cycle picks the task back up.
export async function clearWaitingForInput(taskKey: string): Promise<void> {
  await removeLabel(taskKey, config.jira.blockedLabel);
}

export async function addComment(taskKey: string, body: string): Promise<void> {
  await client.issueComments.addComment({
    issueIdOrKey: taskKey,
    comment: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function transitionTo(taskKey: string, targetName: string): Promise<void> {
  const { transitions } = await client.issues.getTransitions({ issueIdOrKey: taskKey });
  const transition = transitions?.find(t => t.name === targetName);
  if (!transition?.id) {
    console.warn(`[JIRA] No "${targetName}" transition found for ${taskKey}`);
    return;
  }
  await client.issues.doTransition({ issueIdOrKey: taskKey, transition: { id: transition.id } });
}

async function addLabel(taskKey: string, label: string): Promise<void> {
  const issue = await client.issues.getIssue({ issueIdOrKey: taskKey, fields: ['labels'] });
  const labels: string[] = (issue.fields?.labels as string[]) ?? [];
  if (!labels.includes(label)) {
    await client.issues.editIssue({ issueIdOrKey: taskKey, fields: { labels: [...labels, label] } });
  }
}

async function removeLabel(taskKey: string, label: string): Promise<void> {
  const issue = await client.issues.getIssue({ issueIdOrKey: taskKey, fields: ['labels'] });
  const labels: string[] = (issue.fields?.labels as string[]) ?? [];
  await client.issues.editIssue({
    issueIdOrKey: taskKey,
    fields: { labels: labels.filter(l => l !== label) },
  });
}

function parseIssue(issue: any, configByKey: Record<string, ProjectConfig>): JiraTask {
  const comments: JiraComment[] = (issue.fields?.comment?.comments ?? []).map((c: any) => ({
    id: c.id,
    author: c.author?.displayName ?? 'Unknown',
    body: adfToText(c.body),
    created: c.created,
  }));

  // Extract the project key from the issue key, e.g. "AI-123" → "AI"
  const projectKey = (issue.key as string).split('-')[0];
  const projectConfig = configByKey[projectKey];

  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    description: adfToText(issue.fields?.description),
    status: issue.fields?.status?.name ?? '',
    labels: (issue.fields?.labels as string[]) ?? [],
    repository: projectConfig?.repo ?? null,
    slackChannel: projectConfig?.slackChannel ?? null,
    comments,
  };
}

// Minimal Atlassian Document Format → plain text extraction
function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(node.type === 'paragraph' ? '\n' : '');
  }
  return '';
}
