import { Octokit } from '@octokit/core';
import { Logger } from '@proteinjs/util';
import { LocalPackage } from '@proteinjs/util-node';

export type WorkflowRun = {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
};

export type Commit = {
  owner: string;
  repo: string;
  sha: string;
};

export class Github {
  private logger = new Logger(this.constructor.name);
  private authToken: string;

  constructor(authToken?: string) {
    this.authToken = authToken ? authToken : this.getGithubToken();
  }

  private getGithubToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

    throw new Error(`GITHUB_TOKEN env variable not set`);
  }

  /**
   * Check if the workflow run triggered by a commit resulted in packages being built and tested successfully
   *
   * @param workflowName the name of the workflow
   * @param commit the commit that triggered the workflow
   * @param timeout max time to wait for workflow completion
   *
   * @returns true if the ci workflow completed successfully, otherwise throws an error
   */
  async repoCiPassed(workflowName: string, commit: Commit, localPackage: LocalPackage, timeout = 5 * 60 * 1000) {
    const startTime = Date.now();
    while (true) {
      const workflowRun = await this.getWorkflowRun(workflowName, commit);
      if (workflowRun && workflowRun.status === 'completed') {
        if (workflowRun.conclusion === 'success') {
          this.logger.info(`(${localPackage.name}) ci passed for latest version (${localPackage.packageJson.version})`);
          return true;
        }

        throw new Error(`Workflow run failed: ${workflowName}, for commit: ${JSON.stringify(commit)}`);
      }

      if (Date.now() - startTime > timeout)
        throw new Error(`Timed out checking for workflow run: ${workflowName}, for commit: ${JSON.stringify(commit)}`);

      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  private async getWorkflowRun(workflowName: string, commit: Commit): Promise<WorkflowRun | undefined> {
    const octokit = new Octokit({ auth: this.authToken });
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner: commit.owner,
      repo: commit.repo,
      per_page: 10,
    });
    const workflowRuns = response.data.workflow_runs.filter((run) => {
      if (run.head_sha !== commit.sha) return false;

      if (workflowName && run.name !== workflowName) return false;

      return true;
    }) as WorkflowRun[];
    return workflowRuns[0];
  }
}
