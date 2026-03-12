import { spawn } from 'child_process';

export interface ClaudeResult {
  response: string;   // parsed.result
  sessionId: string;  // parsed.session_id
}

export async function runClaude(
  prompt: string,
  options: { cwd?: string; sessionId?: string } = {},
): Promise<ClaudeResult> {
  // Restrict to built-in code tools only — MCP servers (Atlassian, etc.) are
  // handled by the Node.js orchestration layer, not by the Claude subprocess.
  const ALLOWED_TOOLS = [
    'Bash', 'Read', 'Write', 'Edit', 'MultiEdit',
    'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
    'NotebookRead', 'NotebookEdit',
  ].join(',');

  const args = [
    '--print',
    '--output-format', 'json',
    '--allowedTools', ALLOWED_TOOLS,
  ];
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd: options.cwd,
      env: process.env,
    });

    if (!proc.stdin) {
      reject(new Error('Failed to open stdin for claude process'));
      return;
    }

    let stdout = '';
    let stderr = '';

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result: string; session_id: string };
        resolve({
          response: parsed.result,
          sessionId: parsed.session_id,
        });
      } catch {
        reject(new Error(`Failed to parse claude output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', reject);
  });
}

// Finds the last ```json ... ``` block in the response and JSON-parses it.
// Returns null if no valid JSON block is found.
export function extractAction(response: string): Record<string, string> | null {
  const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let lastMatch: string | null = null;

  while ((match = jsonBlockRegex.exec(response)) !== null) {
    lastMatch = match[1];
  }

  if (!lastMatch) return null;

  try {
    return JSON.parse(lastMatch) as Record<string, string>;
  } catch {
    return null;
  }
}
