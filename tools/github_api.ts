import { Octokit } from '@octokit/rest';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  head: string;
  base: string;
  createdAt: string;
  draft: boolean;
}

export interface GitHubMergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface GitHubRepoInfo {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  url: string;
  cloneUrl: string;
  language: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  url: string;
  createdAt: string;
}

export class GitHubApiTool {
  private readonly octokit: Octokit;

  constructor() {
    const token = process.env['GITHUB_TOKEN'];
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Create a new issue in a GitHub repository.
   * repo should be "owner/repo".
   */
  async createIssue(
    repo: string,
    title: string,
    body: string,
    labels: string[] = [],
  ): Promise<GitHubIssue> {
    const { owner, name } = this.parseRepo(repo);

    try {
      const { data } = await this.octokit.issues.create({
        owner,
        repo: name,
        title,
        body,
        labels,
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        url: data.html_url,
        state: data.state,
        labels: data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`createIssue in "${repo}" failed: ${msg}`);
    }
  }

  /**
   * Create a Pull Request in a GitHub repository.
   */
  async createPullRequest(
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<GitHubPullRequest> {
    const { owner, name } = this.parseRepo(repo);

    try {
      const { data } = await this.octokit.pulls.create({
        owner,
        repo: name,
        title,
        body,
        head,
        base,
      });

      return {
        number: data.number,
        title: data.title,
        url: data.html_url,
        state: data.state,
        head: data.head.ref,
        base: data.base.ref,
        createdAt: data.created_at,
        draft: data.draft ?? false,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`createPullRequest in "${repo}" (${head} -> ${base}) failed: ${msg}`);
    }
  }

  /**
   * Merge a Pull Request.
   */
  async mergePullRequest(
    repo: string,
    prNumber: number,
    mergeMethod: MergeMethod = 'merge',
  ): Promise<GitHubMergeResult> {
    const { owner, name } = this.parseRepo(repo);

    try {
      const { data } = await this.octokit.pulls.merge({
        owner,
        repo: name,
        pull_number: prNumber,
        merge_method: mergeMethod,
      });

      return {
        merged: data.merged,
        sha: data.sha ?? '',
        message: data.message ?? '',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`mergePullRequest #${prNumber} in "${repo}" failed: ${msg}`);
    }
  }

  /**
   * Fetch repository metadata.
   */
  async getRepoInfo(repo: string): Promise<GitHubRepoInfo> {
    const { owner, name } = this.parseRepo(repo);

    try {
      const { data } = await this.octokit.repos.get({ owner, repo: name });

      return {
        fullName: data.full_name,
        description: data.description,
        defaultBranch: data.default_branch,
        private: data.private,
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        url: data.html_url,
        cloneUrl: data.clone_url,
        language: data.language ?? null,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`getRepoInfo for "${repo}" failed: ${msg}`);
    }
  }

  /**
   * List open issues for a repository, optionally filtered by labels.
   */
  async listOpenIssues(repo: string, labels: string[] = []): Promise<GitHubIssue[]> {
    const { owner, name } = this.parseRepo(repo);

    try {
      const { data } = await this.octokit.issues.listForRepo({
        owner,
        repo: name,
        state: 'open',
        labels: labels.length > 0 ? labels.join(',') : undefined,
        per_page: 100,
      });

      return data.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        url: issue.html_url,
        state: issue.state,
        labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`listOpenIssues for "${repo}" failed: ${msg}`);
    }
  }

  /**
   * Add a comment to an issue or pull request.
   */
  async addComment(repo: string, issueNumber: number, body: string): Promise<GitHubComment> {
    const { owner, name } = this.parseRepo(repo);

    try {
      const { data } = await this.octokit.issues.createComment({
        owner,
        repo: name,
        issue_number: issueNumber,
        body,
      });

      return {
        id: data.id,
        body: data.body ?? '',
        url: data.html_url,
        createdAt: data.created_at,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`addComment to #${issueNumber} in "${repo}" failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseRepo(repo: string): { owner: string; name: string } {
    const parts = repo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid repo format "${repo}". Expected "owner/repo".`);
    }
    return { owner: parts[0], name: parts[1] };
  }
}
