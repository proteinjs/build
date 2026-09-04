import { parseArgsMap } from '@proteinjs/util-node';
import { reapEstatesOptions } from '../src/reapEstates';

/**
 * The `reap-estates` flag surface for the DATABASE class must land on the reaper's options exactly:
 * the fence, the horizon, and `--db-client-from` (the dirs the Spanner client is borrowed from —
 * the scheduled job's cwd has no app install, so without it the orphan sweep is inert in the very
 * case it exists for: after the estates that would have lent the client are reaped).
 */
describe('reapEstatesOptions', () => {
  const parse = (argv: string[]) => reapEstatesOptions(parseArgsMap(argv));

  test('--db-fence, --db-orphan-days and --db-client-from land on the database class', () => {
    const options = parse([
      '--apply',
      '--db-fence=n3xa-app/n3xa-dev/est-',
      '--db-orphan-days=7',
      '--db-client-from=/repo/packages/app/packages/server,/other/estate',
    ]);
    expect(options.apply).toBe(true);
    expect(options.databases).toEqual({
      fence: { project: 'n3xa-app', instance: 'n3xa-dev', prefix: 'est-' },
      orphanAfterMs: 7 * 24 * 3600_000,
      resolvePaths: ['/repo/packages/app/packages/server', '/other/estate'],
    });
  });

  test('without a fence the database class is absent, and the fence-bound flags refuse to stand alone', () => {
    expect(parse(['--apply']).databases).toBeUndefined();
    expect(() => parse(['--db-orphan-days=7'])).toThrow(/--db-orphan-days needs --db-fence/);
    expect(() => parse(['--db-client-from=/x'])).toThrow(/--db-client-from needs --db-fence/);
    expect(() => parse(['--db-fence=n3xa-dev/est-'])).toThrow(/--db-fence must be <project>\/<instance>\/<prefix>/);
    expect(() => parse(['--db-fence=n3xa-app/n3xa-dev/est-', '--db-orphan-days=0'])).toThrow(/positive number of days/);
  });

  test('--owner and --ttl land as before', () => {
    const options = parse(['--owner=lane-x', '--ttl=48']);
    expect(options.owner).toBe('lane-x');
    expect(options.ttlMs).toBe(48 * 3600_000);
    expect(() => parse(['--ttl=-1'])).toThrow(/--ttl must be a positive number of hours/);
  });
});
