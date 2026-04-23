import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitCloneOptions {
  repoUrl: string;
  targetDir: string;
  branch?: string;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesCommitted: string[];
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitDiffResult {
  fromRef: string;
  toRef: string;
  diff: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface PullRequestResult {
  number: number;
  url: string;
  title: string;
  head: string;
  base: string;
  state: string;
}

export class GitTool {
  private readonly githubApiBase = 'https://api.github.com';
  private readonly githubToken: string;

  constructor() {
    const token = process.env['GITHUB_TOKEN'];
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }
    this.githubToken = token;
  }

  /**
   * Clone a repository to a target directory, optionally checking out a specific branch.
   */
  async clone(repoUrl: string, targetDir: string, branch?: string): Promise<void> {
    const args = ['clone'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push(repoUrl, targetDir);

    try {
      await execFileAsync('git', args);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git clone failed for "${repoUrl}" -> "${targetDir}": ${msg}`);
    }
  }

  /**
   * Stage specific files and create a commit in the given repository directory.
   */
  async commit(repoDir: string, message: string, files: string[]): Promise<GitCommitResult> {
    if (files.length === 0) {
      throw new Error('At least one file must be specified for commit');
    }
    if (!message.trim()) {
      throw new Error('Commit message must not be empty');
    }

    try {
      await execFileAsync('git', ['-C', repoDir, 'add', ...files]);
      const { stdout } = await execFileAsync('git', ['-C', repoDir, 'commit', '-m', message]);

      const hashMatch = stdout.match(/\[[\w/]+ ([a-f0-9]+)\]/);
      const hash = hashMatch?.[1] ?? 'unknown';

      return { hash, message, filesCommitted: files };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git commit failed in "${repoDir}": ${msg}`);
    }
  }

  /**
   * Push commits to a remote repository.
   */
  async push(repoDir: string, remote = 'origin', branch?: string): Promise<void> {
    const args = ['-C', repoDir, 'push', remote];
    if (branch) args.push(branch);

    try {
      await execFileAsync('git', args);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git push failed in "${repoDir}" (remote: ${remote}): ${msg}`);
    }
  }

  /**
   * Create a new branch and check it out in the given repository directory.
   */
  async createBranch(repoDir: string, branchName: string): Promise<void> {
    if (!branchName.trim()) {
      throw new Error('Branch name must not be empty');
    }

    try {
      await execFileAsync('git', ['-C', repoDir, 'checkout', '-b', branchName]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `git checkout -b "${branchName}" failed in "${repoDir}": ${msg}`
      );
    }
  }

  /**
   * Create a GitHub Pull Request via the GitHub API.
   * repoUrl should be in the form "https://github.com/owner/repo" or "owner/repo".
   */
  async createPullRequest(
    repoUrl: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<PullRequestResult> {
    const repo = this.extractOwnerRepo(repoUrl);

    const response = await fetch(`${this.githubApiBase}/repos/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub API createPullRequest failed (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as {
      number: number;
      html_url: string;
      title: string;
      head: { ref: string };
      base: { ref: string };
      state: string;
    };

    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      head: data.head.ref,
      base: data.base.ref,
      state: data.state,
    };
  }

  /**
   * Return the current git status of a repository.
   */
  async getStatus(repoDir: string): Promise<GitStatusResult> {
    try {
      const { stdout: statusOutput } = await execFileAsync('git', ['-C', repoDir, 'status', '--porcelain=v1', '-b']);

      const lines = statusOutput.split('\n').filter(l => l.trim());
      const branchLine = lines.shift() ?? '';

      const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(.+?))?( \[(.+)\])?$/);
      const branch = branchMatch?.[1] ?? 'unknown';

      let ahead = 0;
      let behind = 0;
      if (branchMatch?.[4]) {
        const aheadMatch = branchMatch[4].match(/ahead (\d+)/);
        const behindMatch = branchMatch[4].match(/behind (\d+)/);
        ahead = aheadMatch ? parseInt(aheadMatch[1], 10) : 0;
        behind = behindMatch ? parseInt(behindMatch[1], 10) : 0;
      }

      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        if (!line) continue;
        const xy = line.substring(0, 2);
        const file = line.substring(3);
        const x = xy[0] ?? ' ';
        const y = xy[1] ?? ' ';

        if (x === '?') {
          untracked.push(file);
        } else {
          if (x !== ' ') staged.push(file);
          if (y !== ' ') unstaged.push(file);
        }
      }

      return {
        branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git status failed in "${repoDir}": ${msg}`);
    }
  }

  /**
   * Return the diff between two git refs in a repository.
   */
  async getDiff(repoDir: string, fromRef: string, toRef: string): Promise<GitDiffResult> {
    try {
      const { stdout: diffOutput } = await execFileAsync('git', ['-C', repoDir, 'diff', fromRef, toRef]);
      const { stdout: statOutput } = await execFileAsync('git', ['-C', repoDir, 'diff', '--stat', fromRef, toRef]);

      const filesChanged: string[] = [];
      const fileRegex = /^\s*(.+?)\s+\|/gm;
      let match: RegExpExecArray | null;
      while ((match = fileRegex.exec(statOutput)) !== null) {
        if (match[1]) filesChanged.push(match[1].trim());
      }

      const summaryMatch = statOutput.match(
        /(\d+) insertion[s]?\(\+\).*?(\d+) deletion[s]?\(-\)|(\d+) insertion[s]?\(\+\)|(\d+) deletion[s]?\(-\)/
      );
      let insertions = 0;
      let deletions = 0;
      if (summaryMatch) {
        insertions = parseInt(summaryMatch[1] ?? summaryMatch[3] ?? '0', 10);
        deletions = parseInt(summaryMatch[2] ?? summaryMatch[4] ?? '0', 10);
      }

      return {
        fromRef,
        toRef,
        diff: diffOutput,
        filesChanged,
        insertions,
        deletions,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `git diff failed in "${repoDir}" (${fromRef}..${toRef}): ${msg}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractOwnerRepo(repoUrl: string): string {
    // Accept "owner/repo", "https://github.com/owner/repo", or "git@github.com:owner/repo"
    const httpsMatch = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch?.[1]) return httpsMatch[1];

    const shortMatch = repoUrl.match(/^([^/]+\/[^/]+)$/);
    if (shortMatch?.[1]) return shortMatch[1];

    throw new Error(`Cannot parse owner/repo from URL: "${repoUrl}"`);
  }
}
