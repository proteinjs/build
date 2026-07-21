import { parseMergeToMainSpec } from '../src/mergeToMain';

describe('parseMergeToMainSpec', () => {
  it('is disabled with no flag and no env', () => {
    expect(parseMergeToMainSpec([]).enabled).toBe(false);
    expect(parseMergeToMainSpec(['--dry-run']).enabled).toBe(false);
  });

  it('bare flag enables merge for all repos at branch HEAD', () => {
    const spec = parseMergeToMainSpec(['--merge-to-main']);
    expect(spec.enabled).toBe(true);
    expect(spec.pins.size).toBe(0);
  });

  it('pinned form names repos with shas', () => {
    const spec = parseMergeToMainSpec(['--merge-to-main=chat:17dda73,thought:ffdc105']);
    expect(spec.enabled).toBe(true);
    expect(spec.pins.get('chat')).toBe('17dda73');
    expect(spec.pins.get('thought')).toBe('ffdc105');
    expect(spec.pins.has('flow')).toBe(false);
  });

  it('bare repo name (no sha) pins the repo at its branch HEAD', () => {
    const spec = parseMergeToMainSpec(['--merge-to-main=chat,thought:abc123']);
    expect(spec.pins.has('chat')).toBe(true);
    expect(spec.pins.get('chat')).toBeUndefined();
    expect(spec.pins.get('thought')).toBe('abc123');
  });

  it('repeatable flags accumulate pins', () => {
    const spec = parseMergeToMainSpec(['--merge-to-main=chat:a', '--merge-to-main=flow:b']);
    expect(spec.pins.get('chat')).toBe('a');
    expect(spec.pins.get('flow')).toBe('b');
  });

  it('env var enables when no flag is present; flag wins over env', () => {
    expect(parseMergeToMainSpec([], '1').enabled).toBe(true);
    expect(parseMergeToMainSpec([], 'chat:abc').pins.get('chat')).toBe('abc');
    const flagWins = parseMergeToMainSpec(['--merge-to-main=flow:x'], 'chat:abc');
    expect(flagWins.pins.has('chat')).toBe(false);
    expect(flagWins.pins.get('flow')).toBe('x');
  });
});
