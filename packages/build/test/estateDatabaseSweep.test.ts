import { EstateDatabaseSweep, SpannerAdminClient } from '../src/EstateDatabaseSweep';

/**
 * The database class's fence MUST bite (DEV_ESTATES.md §3.3): a reaped row drops exactly the
 * fenced databases it names; a name outside the prefix or off the fenced instance is refused,
 * never dropped; the orphan sweep drops only fenced databases no row names and only past the
 * horizon; unaged databases are kept; no credential = nothing happens and the skip is said.
 * Asserted as OUTCOMES on a fake admin client (the drops it received), never on call counts alone.
 */

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const FENCE = { project: 'n3xa-app', instance: 'n3xa-dev', prefix: 'est-' };
const KEY = Buffer.from(JSON.stringify({ type: 'service_account', client_email: 'fake@example.iam' })).toString(
  'base64'
);

type Row = { name: string; ageDays?: number };

/** A fake admin client over a fixed database list; records every drop and every instance asked for. */
const fakeSpanner = (rows: Row[]) => {
  const dropped: string[] = [];
  const instancesAsked: string[] = [];
  let closed = 0;
  const client: SpannerAdminClient = {
    instance: (name: string) => {
      instancesAsked.push(name);
      return {
        getDatabases: async () => [
          rows.map((row) => ({
            formattedName_: `projects/${FENCE.project}/instances/${name}/databases/${row.name}`,
            metadata:
              row.ageDays === undefined
                ? {}
                : { createTime: { seconds: Math.floor((NOW - row.ageDays * DAY) / 1000), nanos: 0 } },
          })),
        ],
        database: (dbName: string) => ({
          delete: async () => {
            dropped.push(dbName);
          },
        }),
      };
    },
    close: () => {
      closed += 1;
    },
  };
  return { client, dropped, instancesAsked, closedCount: () => closed };
};

const sweep = (rows: Row[], overrides: Partial<ConstructorParameters<typeof EstateDatabaseSweep>[0]> = {}) => {
  const fake = fakeSpanner(rows);
  const instance = new EstateDatabaseSweep({
    fence: FENCE,
    env: { GCP_SA_KEY: KEY },
    now: () => NOW,
    spannerFactory: () => fake.client,
    ...overrides,
  });
  return { instance, fake };
};

describe('EstateDatabaseSweep — row-scoped drops', () => {
  test('drops exactly the fenced databases a row names; an absent one is a no-op act', async () => {
    const { instance, fake } = sweep([
      { name: 'est-lane-a', ageDays: 1 },
      { name: 'brent-dev-2', ageDays: 100 },
    ]);
    const report = await instance.dropForEstate(
      ['n3xa-app/n3xa-dev/est-lane-a', 'n3xa-app/n3xa-dev/est-lane-a-vm'],
      true
    );
    expect(fake.dropped).toEqual(['est-lane-a']);
    expect(report.refusals).toEqual([]);
    expect(report.acts).toEqual([
      'drop database n3xa-app/n3xa-dev/est-lane-a',
      'database n3xa-app/n3xa-dev/est-lane-a-vm already absent',
    ]);
    expect(fake.instancesAsked).toEqual(['n3xa-dev']);
    expect(fake.closedCount()).toBe(1);
  });

  test("a row naming a database outside the prefix (the founder's brent-dev-2) is REFUSED, never dropped", async () => {
    const { instance, fake } = sweep([
      { name: 'brent-dev-2', ageDays: 100 },
      { name: 'est-ok', ageDays: 1 },
    ]);
    const report = await instance.dropForEstate(['n3xa-app/n3xa-dev/brent-dev-2', 'n3xa-app/n3xa-dev/est-ok'], true);
    expect(fake.dropped).toEqual(['est-ok']);
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]).toMatch(/brent-dev-2: name outside the fenced prefix est-\*/);
  });

  test('a row naming a database on another instance (prod) is REFUSED — the fence is by instance, not by credential', async () => {
    const { instance, fake } = sweep([{ name: 'est-x', ageDays: 1 }]);
    const report = await instance.dropForEstate(['n3xa-app/n3xa-prod/est-x', 'other-project/n3xa-dev/est-x'], true);
    expect(fake.dropped).toEqual([]);
    expect(report.acts).toEqual([]);
    expect(report.refusals).toHaveLength(2);
    expect(report.refusals[0]).toMatch(/outside the fenced instance n3xa-app\/n3xa-dev/);
    expect(fake.instancesAsked).toEqual([]); // no client work at all for an all-refused row
  });

  test('a malformed reference is refused by shape', async () => {
    const { instance, fake } = sweep([{ name: 'est-x', ageDays: 1 }]);
    const report = await instance.dropForEstate(['est-x'], true);
    expect(fake.dropped).toEqual([]);
    expect(report.refusals[0]).toMatch(/not a <project>\/<instance>\/<database> reference/);
  });

  test('without a fence the class is inert: the row is refused, nothing is dropped', async () => {
    const { instance, fake } = sweep([{ name: 'est-x', ageDays: 1 }], { fence: undefined });
    const report = await instance.dropForEstate(['n3xa-app/n3xa-dev/est-x'], true);
    expect(fake.dropped).toEqual([]);
    expect(report.refusals[0]).toMatch(/no database fence configured/);
  });

  test('without a credential nothing is dropped and the refusal names the missing env (never its value)', async () => {
    const { instance, fake } = sweep([{ name: 'est-x', ageDays: 1 }], {
      env: {},
      spannerFactory: undefined, // the default factory: GCP_SA_KEY absent → no client
    });
    const report = await instance.dropForEstate(['n3xa-app/n3xa-dev/est-x'], true);
    expect(fake.dropped).toEqual([]);
    expect(report.refusals[0]).toMatch(/no GCP_SA_KEY in the environment/);
    expect(report.refusals[0]).not.toContain(KEY);
  });

  test('dry-run lists the drops and drops nothing', async () => {
    const { instance, fake } = sweep([{ name: 'est-x', ageDays: 1 }]);
    const report = await instance.dropForEstate(['n3xa-app/n3xa-dev/est-x'], false);
    expect(report.acts).toEqual(['drop database n3xa-app/n3xa-dev/est-x']);
    expect(fake.dropped).toEqual([]);
  });

  test('a drop that fails is a refusal, not a silent success', async () => {
    const { instance, fake } = sweep([{ name: 'est-x', ageDays: 1 }]);
    const failing: SpannerAdminClient = {
      instance: (name) => ({
        ...fake.client.instance(name),
        database: () => ({
          delete: async () => {
            throw new Error('PERMISSION_DENIED: nope');
          },
        }),
      }),
      close: () => undefined,
    };
    const report = await new EstateDatabaseSweep({
      fence: FENCE,
      env: { GCP_SA_KEY: KEY },
      spannerFactory: () => failing,
    }).dropForEstate(['n3xa-app/n3xa-dev/est-x'], true);
    expect(report.refusals[0]).toMatch(/drop failed \(PERMISSION_DENIED: nope\)/);
  });
});

describe('EstateDatabaseSweep — the orphan sweep', () => {
  const ROWS: Row[] = [
    { name: 'est-old-orphan', ageDays: 9 }, // no row, past the 7-day horizon → dropped
    { name: 'est-young-orphan', ageDays: 2 }, // no row, young → kept with the counterfactual
    { name: 'est-registered', ageDays: 30 }, // a row names it → kept, whatever its age
    { name: 'est-unaged' }, // no createTime → never dropped
    { name: 'brent-dev', ageDays: 700 }, // outside the prefix → never even judged
    { name: 'brent-dev-2', ageDays: 200 },
  ];

  test('drops only fenced, unregistered databases past the horizon; keeps the rest with reasons', async () => {
    const { instance, fake } = sweep(ROWS);
    const report = await instance.sweepOrphans(new Set(['n3xa-app/n3xa-dev/est-registered']), true);
    expect(fake.dropped).toEqual(['est-old-orphan']);
    expect(report.acts).toEqual([
      'drop orphan database n3xa-app/n3xa-dev/est-old-orphan (9.0d old, no registered estate)',
    ]);
    expect(report.kept).toEqual([
      'n3xa-app/n3xa-dev/est-young-orphan: no registered estate, 2.0d old < 7.0d — would drop at the horizon (estate adopt --id … to keep it)',
      'n3xa-app/n3xa-dev/est-registered: named by a registered estate',
      'n3xa-app/n3xa-dev/est-unaged: no registered estate, age unknown — kept (never dropped unaged)',
    ]);
    expect(report.refusals).toEqual([]);
    expect(report.skipped).toBeUndefined();
    // The founder's databases are outside the family: not dropped, not judged, not named.
    expect(JSON.stringify(report)).not.toContain('brent-dev');
  });

  test('a database a PINNED (or any) row names is never an orphan, even at ten times the horizon', async () => {
    const { instance, fake } = sweep([{ name: 'est-pinned', ageDays: 70 }]);
    const report = await instance.sweepOrphans(new Set(['n3xa-app/n3xa-dev/est-pinned']), true);
    expect(fake.dropped).toEqual([]);
    expect(report.kept).toEqual(['n3xa-app/n3xa-dev/est-pinned: named by a registered estate']);
  });

  test('the horizon is configurable (D1) and dry-run drops nothing', async () => {
    const { instance, fake } = sweep([{ name: 'est-three-days', ageDays: 3 }], { orphanAfterMs: 2 * DAY });
    const dry = await instance.sweepOrphans(new Set(), false);
    expect(dry.acts).toHaveLength(1);
    expect(fake.dropped).toEqual([]);
    const applied = await instance.sweepOrphans(new Set(), true);
    expect(applied.acts).toHaveLength(1);
    expect(fake.dropped).toEqual(['est-three-days']);
  });

  test('no fence / no credential = skipped with the reason, nothing listed or dropped', async () => {
    const noFence = sweep(ROWS, { fence: undefined });
    const skipped = await noFence.instance.sweepOrphans(new Set(), true);
    expect(skipped.skipped).toMatch(/no database fence configured/);
    expect(noFence.fake.dropped).toEqual([]);
    expect(noFence.fake.instancesAsked).toEqual([]);

    const noKey = sweep(ROWS, { env: {}, spannerFactory: undefined });
    const skippedKey = await noKey.instance.sweepOrphans(new Set(), true);
    expect(skippedKey.skipped).toMatch(/no GCP_SA_KEY in the environment/);
    expect(noKey.fake.dropped).toEqual([]);
  });
});

describe('EstateDatabaseSweep — references and fences', () => {
  test('parseRef / formatRef round-trip; parseFence names the shape on a bad flag', () => {
    expect(EstateDatabaseSweep.parseRef('n3xa-app/n3xa-dev/est-x')).toEqual({
      project: 'n3xa-app',
      instance: 'n3xa-dev',
      name: 'est-x',
    });
    expect(EstateDatabaseSweep.parseRef('n3xa-dev/est-x')).toBeUndefined();
    expect(EstateDatabaseSweep.parseRef('a//c')).toBeUndefined();
    expect(EstateDatabaseSweep.formatRef({ project: 'p', instance: 'i', name: 'n' })).toBe('p/i/n');
    expect(EstateDatabaseSweep.parseFence('n3xa-app/n3xa-dev/est-')).toEqual(FENCE);
    expect(() => EstateDatabaseSweep.parseFence('n3xa-dev/est-')).toThrow(
      /--db-fence must be <project>\/<instance>\/<prefix>/
    );
  });
});
