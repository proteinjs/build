import { NodeModulesEntrySample, NodeModulesIdentityWatcher } from '../src/NodeModulesIdentityWatcher';

/**
 * Pure fingerprint semantics: equal iff every watched entry has identical PACKAGE IDENTITY
 * (resolution location, symlink-ness, symlink target). Sample order must never matter, and
 * every identity dimension must matter — each is a real churn class (npm hole, registry-copy
 * clobber, retargeted link, hoist move).
 */
describe('NodeModulesIdentityWatcher fingerprint', () => {
  const sample = (overrides: Partial<NodeModulesEntrySample> = {}): NodeModulesEntrySample => ({
    consumer: '@test/consumer',
    packageDir: '/ws/packages/consumer',
    depName: '@test/lib',
    entryPath: '/ws/packages/consumer/node_modules/@test/lib',
    kind: 'symlink',
    realPath: '/ws/packages/lib',
    ...overrides,
  });
  const external = (overrides: Partial<NodeModulesEntrySample> = {}): NodeModulesEntrySample =>
    sample({
      depName: 'left-pad',
      entryPath: '/ws/packages/consumer/node_modules/left-pad',
      kind: 'real-dir',
      realPath: undefined,
      ...overrides,
    });

  it('is order-insensitive: the same samples in any order fingerprint identically', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([sample(), external()])).toBe(
      NodeModulesIdentityWatcher.fingerprint([external(), sample()])
    );
  });

  it('identical identities fingerprint identically across distinct sample objects', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([sample()])).toBe(NodeModulesIdentityWatcher.fingerprint([sample()]));
  });

  it('a symlink becoming a real directory changes the fingerprint (registry-copy clobber)', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([sample()])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([sample({ kind: 'real-dir', realPath: undefined })])
    );
  });

  it('a retargeted symlink changes the fingerprint', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([sample()])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([sample({ realPath: '/elsewhere/lib' })])
    );
  });

  it('a broken symlink (unresolvable target) is its own identity', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([sample()])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([sample({ realPath: undefined })])
    );
  });

  it('a real directory and a broken symlink at the same path are distinct identities (kind matters alone)', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([sample({ kind: 'real-dir', realPath: undefined })])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([sample({ kind: 'symlink', realPath: undefined })])
    );
  });

  it('an entry going missing changes the fingerprint (mid-install hole)', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([external()])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([external({ kind: 'missing', entryPath: undefined })])
    );
  });

  it('a hoist move (same kind, different resolved entry path) changes the fingerprint', () => {
    expect(NodeModulesIdentityWatcher.fingerprint([external()])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([external({ entryPath: '/ws/node_modules/left-pad' })])
    );
  });

  it('the same dep under DIFFERENT consumers is two entries, not one', () => {
    const other = sample({ consumer: '@test/other', packageDir: '/ws/packages/other' });
    expect(NodeModulesIdentityWatcher.fingerprint([sample(), other])).not.toBe(
      NodeModulesIdentityWatcher.fingerprint([sample(), sample()])
    );
  });

  describe('changedEntries', () => {
    it('labels exactly the entries whose identity changed', () => {
      const previous = [sample(), external()];
      const next = [sample({ kind: 'real-dir', realPath: undefined }), external()];
      expect(NodeModulesIdentityWatcher.changedEntries(previous, next)).toEqual(['@test/lib (in @test/consumer)']);
    });

    it('reports entries added to or removed from the watched set', () => {
      expect(NodeModulesIdentityWatcher.changedEntries([sample()], [sample(), external()])).toEqual([
        'left-pad (in @test/consumer)',
      ]);
      expect(NodeModulesIdentityWatcher.changedEntries([sample(), external()], [sample()])).toEqual([
        'left-pad (in @test/consumer)',
      ]);
    });

    it('returns empty for identical sample sets regardless of order', () => {
      expect(NodeModulesIdentityWatcher.changedEntries([sample(), external()], [external(), sample()])).toEqual([]);
    });
  });
});
