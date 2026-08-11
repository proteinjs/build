import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { cmd } from '@proteinjs/util-node';
import { pullWorkspaceRepos } from '../src/syncWorkspace';

/**
 * Hermetic git fixtures (no npm, no network): an origin repo and a workspace checkout wired the
 * way the metarepo is — submodule under packages/ on branch main, `pull.rebase = true`. Stages
 * the observed failure class: builds churn package-lock.json in the working tree, and a plain
 * rebase pull refuses over the unstaged noise, silently stranding the repo behind origin
 * (2026-08-10: packages/util 148 commits behind after a "successful" sync).
 */

const git = (cwd: string, ...args: string[]) =>
  cmd('git', args, { cwd }, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } });

const initRepo = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@test.test');
  await git(dir, 'config', 'user.name', 'test');
};

const commitFile = async (repo: string, file: string, content: string, message: string) => {
  await fs.writeFile(path.join(repo, file), content);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', message);
};

describe('pullWorkspaceRepos', () => {
  let tmp: string;
  let originSub: string;
  let workspace: string;
  let subCheckout: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-pull-test-'));

    originSub = path.join(tmp, 'origin-sub');
    await initRepo(originSub);
    await commitFile(originSub, 'package-lock.json', '{"lockfileVersion":3}\n', 'init');

    workspace = path.join(tmp, 'workspace');
    await initRepo(workspace);
    await commitFile(workspace, 'package.json', '{"name":"root","private":true}\n', 'root init');
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originSub, 'packages/sub');
    await git(workspace, 'commit', '-m', 'add sub');
    subCheckout = path.join(workspace, 'packages', 'sub');
    // The metarepo repos pull with rebase — the config that turns lockfile churn into a refusal.
    await git(subCheckout, 'config', 'pull.rebase', 'true');

    // Origin moves ahead of the checkout.
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const churnLockfile = () =>
    fs.writeFile(path.join(subCheckout, 'package-lock.json'), '{"lockfileVersion":3,"churn":true}\n');

  const head = async (repo: string) => (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();

  it('REPRO: a plain rebase pull refuses over build-churned lockfile noise', async () => {
    await churnLockfile();
    await expect(git(subCheckout, 'pull')).rejects.toThrow();
  });

  it('pulls through lockfile churn and preserves the local change', async () => {
    await churnLockfile();
    const failures = await pullWorkspaceRepos(workspace);
    expect(failures).toEqual([]);
    expect(await head(subCheckout)).toEqual(await head(originSub));
    // Autostash restored the churn — nothing was silently discarded.
    const lockfile = await fs.readFile(path.join(subCheckout, 'package-lock.json'), 'utf-8');
    expect(lockfile).toContain('churn');
  });

  it('named-repo mode pulls that repo through churn', async () => {
    await churnLockfile();
    const failures = await pullWorkspaceRepos(workspace, ['sub']);
    expect(failures).toEqual([]);
    expect(await head(subCheckout)).toEqual(await head(originSub));
  });

  it('a repo that cannot pull is reported and does not strand the rest of the sweep', async () => {
    const originSub2 = path.join(tmp, 'origin-sub2');
    await initRepo(originSub2);
    await commitFile(originSub2, 'a.txt', 'a\n', 'init');
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originSub2, 'packages/sub2');
    await git(workspace, 'commit', '-m', 'add sub2');
    const sub2Checkout = path.join(workspace, 'packages', 'sub2');
    // A detached HEAD has no branch to pull — a real wedge autostash cannot paper over.
    await git(sub2Checkout, 'checkout', '--detach');

    await churnLockfile();
    const failures = await pullWorkspaceRepos(workspace);
    expect(failures.map((f) => f.repoPath)).toEqual(['packages/sub2']);
    expect(failures[0].detail).not.toHaveLength(0);
    // The wedged repo did not stop the sweep: sub still pulled to origin tip.
    expect(await head(subCheckout)).toEqual(await head(originSub));
  });
});
