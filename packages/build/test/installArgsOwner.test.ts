import * as path from 'path';
import * as fs from 'fs/promises';
import { MATERIALIZE_INSTALL_ARGS } from '../src/materializeDependencies';

/**
 * npm-install args have ONE owner. Every `npm install` this package spawns — build-workspace's
 * and the doctor's materialization, pull-forward's manifest installs, version-workspace's CI
 * installs, and the test fixtures' — reads MATERIALIZE_INSTALL_ARGS, so the audit and funding
 * round trips are off everywhere at once: on 2026-09-04 the registry's advisories endpoint
 * stalled every audited install for minutes, and the pullForward fixture's bare `npm install`
 * (a second owner, on npm's defaults) timed the suite out at a train departure. A quoted
 * `install` (or its alias `i`) token inside an args list anywhere else under src/ or test/ is
 * that second owner again.
 */
describe('npm install args', () => {
  const packageDir = path.resolve(__dirname, '..');
  const owner = 'src/materializeDependencies.ts';
  const self = path.relative(packageDir, __filename);
  const installToken = /\[[^\]]*(['"])(install|i)\1/;

  it('the owner turns the audit and funding round trips off', () => {
    expect(MATERIALIZE_INSTALL_ARGS).toEqual(['install', '--no-audit', '--no-fund']);
  });

  it('no other src/ or test/ file spells its own install token', async () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'test']) {
      for (const file of await tsFilesUnder(path.join(packageDir, dir))) {
        const rel = path.relative(packageDir, file);
        if (rel === owner || rel === self) {
          continue;
        }
        const lines = (await fs.readFile(file, 'utf-8')).split('\n');
        lines.forEach((line, i) => {
          if (installToken.test(line)) {
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

const tsFilesUnder = async (dir: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await tsFilesUnder(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
};
