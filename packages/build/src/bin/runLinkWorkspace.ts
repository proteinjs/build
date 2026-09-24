#!/usr/bin/env node
/**
 * link-workspace — the CI door of the linked workspace (src/links/LinkedWorkspace.js).
 *
 *   link-workspace plan [--train]            the links: `.train/links.json` (--train) or LINKS / DEPLOY_ENVIRONMENT /
 *                                            DOCKERFILE (the dev deploy); outputs repos=, <repo>=<sha>, manifest=
 *   link-workspace resolve                   (the dev deploy) each ref -> sha through `gh api`; outputs <repo>=<sha>, manifest=
 *   link-workspace install                   every workspace package at its own lock, none built
 *   link-workspace link [--train] [--record <file>]
 *                                            build + pack each linked package, put the packs in place of every registry
 *                                            copy, judge the installed graph; --record writes the train-links record
 *                                            (the verify's artifact); the dev deploy reads BUILD_LINKS / BUILD_VERSION
 *   link-workspace graph                     the installed graph alone
 *   link-workspace assert --record <file>    the linked copies as installed now hash to the record (after the build)
 *   link-workspace prove --out <file>        (the publish run) the departed tip equivalent to the verified one:
 *                                            HEAD^'s links, the verify run's record (VERIFY_WORKFLOW, gh), the installed
 *                                            copies' hashes, the locks' equivalence, the package.json diffs; outputs
 *                                            links_proven=; exit 0 always (a failed proof tests, never fails)
 *   link-workspace mints --out <file>        (finalize, after the publish) the published tarballs' hashes for the tags at HEAD
 *   link-workspace equivalence --before <lock> --after <lock> [--linked a,b]
 *
 * Env: LINK_OWNER (default n3xah), LINK_REPOS (the allow-list, comma), LINK_SCOPES (the internal scopes, comma),
 * LINKS_DIR (default ./links), GITHUB_OUTPUT (the step outputs), VERIFY_WORKFLOW (prove: the verify-train file).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// The cores are plain JS (one file each, copied verbatim into n3xa's metarepo where noted).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LinkedWorkspace } = require('../links/LinkedWorkspace');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InstalledGraph } = require('../links/InstalledGraph');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LockEquivalence } = require('../links/LockEquivalence');

type Argv = { verb: string; flags: Record<string, string | true> };

const parse = (argv: string[]): Argv => {
  const [verb, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument ${arg}`);
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = rest[i + 1];
      i += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { verb: verb || '', flags };
};

const list = (value: string | undefined): string[] | undefined =>
  value === undefined || value === ''
    ? undefined
    : value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const gitOrNull = (args: string[], cwd: string): string | null => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

const gh = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync('gh', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

const output = (env: NodeJS.ProcessEnv, lines: string[]) => {
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, lines.map((l) => `${l}\n`).join(''));
  }
  for (const line of lines) {
    console.log(`output ${line}`);
  }
};

const main = async () => {
  const { verb, flags } = parse(process.argv.slice(2));
  const env = process.env;
  const repoRoot = process.cwd();
  const links = new LinkedWorkspace({
    repoRoot,
    linksDir: env.LINKS_DIR ? path.resolve(env.LINKS_DIR) : path.join(repoRoot, 'links'),
    owner: env.LINK_OWNER || 'n3xah',
    repos: list(env.LINK_REPOS) || LinkedWorkspace.DEFAULT_REPOS,
    scopes: list(env.LINK_SCOPES) || LinkedWorkspace.DEFAULT_SCOPES,
  });
  const trainFile = path.join(repoRoot, LinkedWorkspace.TRAIN_LINKS_FILE);
  const trainText = fs.existsSync(trainFile) ? fs.readFileSync(trainFile, 'utf8') : null;
  const planned = () =>
    flags.train
      ? links.planFromTrain(trainText)
      : links.plan({
          links: env.LINKS,
          environment: env.DEPLOY_ENVIRONMENT,
          dockerfile: env.DOCKERFILE && fs.existsSync(env.DOCKERFILE) ? fs.readFileSync(env.DOCKERFILE, 'utf8') : '',
        });

  if (verb === 'plan') {
    const plan = planned();
    console.log(
      plan.length
        ? `links planned: ${plan.map((l: { repo: string; ref: string }) => `${l.repo}=${l.ref}`).join(', ')}`
        : `no links — the registry road${flags.train ? ' (no .train/links.json at the tip)' : ''}`
    );
    const lines = [`repos=${plan.map((l: { repo: string }) => l.repo).join(',')}`];
    if (flags.train) {
      for (const l of plan) {
        lines.push(`${l.repo}=${l.sha}`);
      }
      lines.push(`manifest=${LinkedWorkspace.renderManifest(plan)}`);
    }
    output(env, lines);
    return;
  }
  if (verb === 'resolve') {
    const plan = links.plan({
      links: env.LINKS,
      environment: env.DEPLOY_ENVIRONMENT,
      dockerfile: fs.readFileSync(env.DOCKERFILE as string, 'utf8'),
    });
    const resolved = links.resolve(plan, (repo: string, ref: string) =>
      gh(['api', `repos/${links.owner}/${repo}/commits/${ref}`, '--jq', '.sha'], env)
    );
    for (const { repo, ref, sha } of resolved) {
      console.log(`${repo}=${ref} -> ${sha}`);
    }
    output(env, [
      ...resolved.map(({ repo, sha }: { repo: string; sha: string }) => `${repo}=${sha}`),
      `manifest=${LinkedWorkspace.renderManifest(resolved)}`,
    ]);
    return;
  }
  if (verb === 'install') {
    await links.install();
    return;
  }
  if (verb === 'link') {
    const plan = flags.train ? links.planFromTrain(trainText) : links.parseManifest(env.BUILD_LINKS);
    if (flags.train) {
      // The train's link installs every package at its own lock first (the dev deploy's Dockerfile runs `install` as its own layer).
      await links.install();
    }
    const receipts = links.link({
      links: plan,
      buildVersion: env.BUILD_VERSION,
      requireBuildPrefix: flags.train ? null : 'dev-',
    });
    if (plan.length) {
      const graph = new InstalledGraph({ repoRoot, scopes: links.scopes });
      if (!graph.run().ok) {
        throw new Error('the installed graph is not coherent after the link');
      }
    }
    if (typeof flags.record === 'string') {
      const record = links.record({ tip: git(['rev-parse', 'HEAD'], repoRoot), links: plan, receipts });
      fs.mkdirSync(path.dirname(flags.record), { recursive: true });
      fs.writeFileSync(flags.record, JSON.stringify(record, null, 2) + '\n');
      console.log(`link-workspace: record written to ${flags.record} (${receipts.length} package(s))`);
    }
    return;
  }
  if (verb === 'graph') {
    if (!new InstalledGraph({ repoRoot, scopes: links.scopes }).run().ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (verb === 'assert') {
    if (typeof flags.record !== 'string') {
      throw new Error('assert needs --record <file>');
    }
    const record = JSON.parse(fs.readFileSync(flags.record, 'utf8'));
    const verdict = links.assert({ record });
    console.log(
      verdict.ok
        ? `link-workspace: ${verdict.checked} linked cop${verdict.checked === 1 ? 'y' : 'ies'} still hash to the packs`
        : `link-workspace: the linked copies were CLOBBERED after the link:\n${verdict.findings.map((f: string) => `  ${f}`).join('\n')}`
    );
    if (!verdict.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (verb === 'prove') {
    if (typeof flags.out !== 'string') {
      throw new Error('prove needs --out <file>');
    }
    const proof = prove(links, repoRoot, env);
    fs.mkdirSync(path.dirname(flags.out), { recursive: true });
    fs.writeFileSync(flags.out, JSON.stringify(proof, null, 2) + '\n');
    console.log(`link-workspace prove: ${proof.ok ? 'EQUIVALENT' : 'NOT equivalent'} — ${proof.why.join('; ')}`);
    output(env, [`links_proven=${proof.ok ? 'true' : 'false'}`]);
    return;
  }
  if (verb === 'mints') {
    if (typeof flags.out !== 'string') {
      throw new Error('mints needs --out <file>');
    }
    const commit = git(['rev-parse', 'HEAD'], repoRoot);
    const tags = git(['tag', '--points-at', 'HEAD'], repoRoot).split('\n').filter(Boolean);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'link-workspace-mints-'));
    try {
      const mints = links.mints({
        tags,
        pack: (name: string, version: string) => {
          const [{ filename }] = JSON.parse(
            execFileSync(
              'npm',
              ['pack', `${name}@${version}`, '--ignore-scripts', '--json', '--pack-destination', tmp],
              {
                cwd: repoRoot,
                encoding: 'utf8',
                env,
                stdio: ['ignore', 'pipe', 'inherit'],
              }
            )
          );
          return path.join(tmp, filename);
        },
      });
      fs.mkdirSync(path.dirname(flags.out), { recursive: true });
      fs.writeFileSync(flags.out, JSON.stringify({ commit, mints }, null, 2) + '\n');
      for (const m of mints) {
        console.log(`link-workspace mints: ${m.tag} dist ${m.hash}`);
      }
      console.log(`link-workspace mints: ${mints.length} published tarball(s) hashed to ${flags.out}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  if (verb === 'equivalence') {
    if (typeof flags.before !== 'string' || typeof flags.after !== 'string') {
      throw new Error('equivalence needs --before <lock> --after <lock>');
    }
    const verdict = LockEquivalence.judge(fs.readFileSync(flags.before, 'utf8'), fs.readFileSync(flags.after, 'utf8'), {
      linked: list(typeof flags.linked === 'string' ? flags.linked : '') || [],
    });
    console.log(
      verdict.equivalent
        ? 'link-workspace equivalence: EQUIVALENT'
        : `link-workspace equivalence: NOT equivalent\n${LockEquivalence.describe(verdict.differences)
            .map((l: string) => `  ${l}`)
            .join('\n')}`
    );
    if (!verdict.equivalent) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    'usage: link-workspace plan|resolve|install|link|graph|assert|prove|mints|equivalence (see the file header)'
  );
};

/** The publish run's proof (see LinkedWorkspace.prove): the parent's links, the verify run's record, the trees' locks and package.json diffs. Never throws past its own catch — a proof that cannot be made is `ok: false` with the reason. */
const prove = (links: any, repoRoot: string, env: NodeJS.ProcessEnv) => {
  const head = git(['rev-parse', 'HEAD'], repoRoot);
  const parent = gitOrNull(['rev-parse', 'HEAD^'], repoRoot);
  const parentLinks = parent ? gitOrNull(['show', `${parent}:${LinkedWorkspace.TRAIN_LINKS_FILE}`], repoRoot) : null;
  let plan: any[] = [];
  try {
    plan = links.planFromTrain(parentLinks);
  } catch (err) {
    return {
      ok: false,
      tip: head,
      parent,
      judged: [],
      packages: [],
      locks: [],
      manifests: [],
      why: [(err as Error).message],
    };
  }
  if (!plan.length) {
    return {
      ok: true,
      tip: head,
      parent,
      judged: [],
      packages: [],
      locks: [],
      manifests: [],
      why: ['no links at the parent: the plain road'],
    };
  }
  let record = null;
  let recordWhy = '';
  try {
    record = verifyRecord(parent as string, env);
    if (!record) {
      recordWhy = `no green ${env.VERIFY_WORKFLOW || 'verify-train'} run with a ${LinkedWorkspace.LINKS_ARTIFACT} artifact is named for ${(parent as string).slice(0, 12)}`;
    }
  } catch (err) {
    recordWhy = `the verify record could not be read: ${(err as Error).message.split('\n')[0]}`;
  }
  const trees = new InstalledGraph({ repoRoot, scopes: links.scopes })
    .loadTrees()
    .map((tree: { rel: string; dir: string }) => ({
      rel: tree.rel,
      lockBefore: gitOrNull(['show', `${parent}:${path.posix.join(tree.rel, 'package-lock.json')}`], repoRoot),
      lockAfter: fs.existsSync(path.join(tree.dir, 'package-lock.json'))
        ? fs.readFileSync(path.join(tree.dir, 'package-lock.json'), 'utf8')
        : null,
      packageJsonDiff: gitOrNull(
        ['diff', '-U0', parent as string, head, '--', path.posix.join(tree.rel, 'package.json')],
        repoRoot
      ),
    }));
  const proof = links.prove({ links: plan, record, trees });
  if (recordWhy) {
    proof.why.unshift(recordWhy);
  }
  return { tip: head, parent, ...proof };
};

/** The `train-links` record of the green verify run named for `sha` (or a push run whose head it is), through gh; null when none. */
const verifyRecord = (sha: string, env: NodeJS.ProcessEnv) => {
  const workflow = env.VERIFY_WORKFLOW;
  if (!workflow) {
    throw new Error('VERIFY_WORKFLOW (the verify-train workflow file name) is not staged');
  }
  const runs = JSON.parse(
    gh(
      [
        'run',
        'list',
        '--workflow',
        workflow,
        '-L',
        '100',
        '--json',
        'databaseId,displayTitle,headSha,event,status,conclusion',
      ],
      env
    )
  ) as {
    databaseId: number;
    displayTitle: string;
    headSha: string;
    event: string;
    status: string;
    conclusion: string;
  }[];
  const green = runs
    .filter((r) => r.status === 'completed' && r.conclusion === 'success')
    .filter((r) => r.displayTitle === `verify-train ${sha}` || (r.event === 'push' && r.headSha === sha))
    .sort((a, b) => b.databaseId - a.databaseId);
  for (const run of green) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-links-'));
    try {
      gh(['run', 'download', String(run.databaseId), '-n', LinkedWorkspace.LINKS_ARTIFACT, '-D', dir], env);
      const file = path.join(dir, `${LinkedWorkspace.LINKS_ARTIFACT}.json`);
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch {
      // a green run without the artifact (a plain verify of the parent): the next candidate
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
};

main().catch((e) => {
  console.error(`link-workspace ${process.argv[2] || ''}: ${e.message}`);
  process.exit(1);
});
