'use strict';
const { testTimeoutForBackend } = require('../knobs');

/**
 * The per-test clock of a package whose tests drive a backend is DERIVED from the database
 * driver's per-operation deadline, never typed by hand: two deadlines — one for the test's own
 * work at an operation's worst latency, one for a single stalled operation the driver still
 * tolerates — so a stalled operation fails as the driver's NAMED error, never as jest's bare
 * timeout. A clock at or below the deadline is exactly the flake: jest kills the test first.
 */

describe('testTimeoutForBackend()', () => {
  test('two operation deadlines: the driver names a stalled op before jest can kill the test', () => {
    expect(testTimeoutForBackend(60_000)).toBe(120_000);
    expect(testTimeoutForBackend(150)).toBe(300);
  });

  test('a deadline that is not a positive number is refused at config load, never a silent clock', () => {
    expect(() => testTimeoutForBackend(undefined)).toThrow(/operation deadline/);
    expect(() => testTimeoutForBackend(0)).toThrow(/operation deadline/);
    expect(() => testTimeoutForBackend('60000')).toThrow(/operation deadline/);
  });
});
