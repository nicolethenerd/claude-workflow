export interface ProjectConfig {
  key: string;         // JIRA project key, e.g. "AI"
  repo: string;        // GitHub repo in "owner/repo" format
  slackChannel: string; // Slack channel ID, e.g. "C0123456789"
}

export interface JiraTask {
  id: string;
  key: string;
  summary: string;
  description: string;
  status: string;
  labels: string[];
  repository: string | null;  // "owner/repo" from projects.json
  slackChannel: string | null; // Slack channel ID from projects.json
  comments: JiraComment[];
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
}

// Stored in WORKSPACE_DIR/slack-threads.json
// Maps Slack thread timestamp → JIRA task key
export type SlackThreadMap = Record<string, string>;

export interface AgentContext {
  task: JiraTask;
  workspaceDir: string; // Absolute path to this task's working directory
}
