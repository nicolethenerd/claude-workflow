import { Octokit } from '@octokit/rest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { config } from '../config';

const octokit = new Octokit({ auth: config.github.token });

// Pull latest changes in an existing local repo.
// Errors if the directory is not already a git repository — agents work in
// local repos, never clone fresh copies.
export async function prepareRepo(workspaceDir: string): Promise<void> {
  const git = simpleGit(workspaceDir);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    throw new Error(
      `${workspaceDir} is not a git repository. ` +
      `Check that WORKSPACE_DIR in .env points to your local development folder.`,
    );
  }
  // Fetch first so origin/HEAD is current, then switch to the default branch
  // before pulling. This avoids "no tracking information" errors when the repo
  // is sitting on a leftover agent branch from a previous run.
  await git.fetch('origin');
  const defaultBranch = await getDefaultBranch(git);
  await git.checkout(defaultBranch);
  await git.pull('origin', defaultBranch);
}

async function getDefaultBranch(git: SimpleGit): Promise<string> {
  try {
    const ref = await git.revparse(['--abbrev-ref', 'origin/HEAD']);
    return ref.trim().replace('origin/', '');
  } catch {
    return 'main';
  }
}

export async function createBranch(workspaceDir: string, branchName: string): Promise<void> {
  const git = simpleGit(workspaceDir);
  await git.checkoutLocalBranch(branchName);
}

export async function commitAndPush(workspaceDir: string, message: string, ownerRepo: string): Promise<void> {
  const git = simpleGit(workspaceDir);
  await git.add('.');
  await git.commit(message);
  // Push via HTTPS with token so SSH keys are not required
  const pushUrl = `https://${config.github.token}@github.com/${ownerRepo}.git`;
  await git.push(pushUrl, 'HEAD');
}

// owner/repo format, e.g. "acme/my-app"
export async function createPullRequest(
  ownerRepo: string,
  title: string,
  body: string,
  head: string,
  base: string = 'main',
): Promise<string> {
  const [owner, repo] = ownerRepo.split('/');
  const pr = await octokit.pulls.create({ owner, repo, title, body, head, base });
  return pr.data.html_url;
}

// Build a git-safe branch name from a JIRA key and task summary.
// e.g. "PROJ-42" + "Add dark mode" → "agent/proj-42-add-dark-mode"
export function buildBranchName(taskKey: string, summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `agent/${taskKey.toLowerCase()}-${slug}`;
}
