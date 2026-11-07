'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { workers } = require('../knobs');

/**
 * The pressure-valve advisory (RESOURCE_GOVERNANCE §B.3): under memory pressure the local
 * estate-watchdog drops `<estate home>/advisories/jest-workers`, and `workers()` honors it as a
 * CEILING — the machine-output form of the -w=1 throttle practice. Env stays the outright winner
 * (an explicit operator/CI choice), and a stale advisory (a watchdog that stopped running) is
 * ignored rather than throttling forever.
 */

describe('workers() pressure-valve advisory', () => {
  let home;
  const savedHome = process.env.N3XA_ESTATE_HOME;
  const savedWorkers = process.env.JEST_WORKERS;

  const writeAdvisory = (value, ageMs = 0) => {
    const advisoriesDir = path.join(home, 'advisories');
    fs.mkdirSync(advisoriesDir, { recursive: true });
    const advisoryPath = path.join(advisoriesDir, 'jest-workers');
    fs.writeFileSync(advisoryPath, `${value}\n`);
    if (ageMs > 0) {
      const past = new Date(Date.now() - ageMs);
      fs.utimesSync(advisoryPath, past, past);
    }
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'knobs-advisory-test-'));
    process.env.N3XA_ESTATE_HOME = home;
    delete process.env.JEST_WORKERS;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) {
      delete process.env.N3XA_ESTATE_HOME;
    } else {
      process.env.N3XA_ESTATE_HOME = savedHome;
    }
    if (savedWorkers === undefined) {
      delete process.env.JEST_WORKERS;
    } else {
      process.env.JEST_WORKERS = savedWorkers;
    }
  });

  test('a fresh advisory caps the package default (the -w=1 throttle as machine output)', () => {
    writeAdvisory('1');
    expect(workers(4)).toBe(1);
  });

  test('the advisory is a ceiling, never a raise', () => {
    writeAdvisory('4');
    expect(workers(2)).toBe(2);
  });

  test('JEST_WORKERS env wins outright over the advisory (explicit operator/CI choice)', () => {
    writeAdvisory('1');
    process.env.JEST_WORKERS = '8';
    expect(workers(2)).toBe(8);
  });

  test('a stale advisory (>24h — a watchdog that stopped running) is ignored', () => {
    writeAdvisory('1', 25 * 3600 * 1000);
    expect(workers(4)).toBe(4);
  });

  test('a percentage-string default is stood in for by the advisory count', () => {
    writeAdvisory('1');
    expect(workers('50%')).toBe(1);
  });

  test('no advisory: a package default passes through untouched (the pre-practice road)', () => {
    expect(workers(4)).toBe(4);
    expect(workers('50%')).toBe('50%');
  });

  test('JEST_WORKERS unset and no package default: the physical cores — half the logical count, at least 1 (DECISIONS 764: the jsdom legs at jest’s cpus − 1 ran 7–10× slower on the pool)', () => {
    const spy = jest.spyOn(os, 'availableParallelism');
    try {
      for (const [logical, expected] of [
        [8, 4],
        [14, 7],
        [1, 1],
        [2, 1],
        [3, 1],
      ]) {
        spy.mockReturnValue(logical);
        expect(workers()).toBe(expected);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('the advisory caps the physical-cores default too', () => {
    writeAdvisory('1');
    const spy = jest.spyOn(os, 'availableParallelism').mockReturnValue(8);
    try {
      expect(workers()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('an env handed in is read in place of process.env (the preset’s builder hands its own)', () => {
    process.env.JEST_WORKERS = '8';
    expect(workers(undefined, { JEST_WORKERS: '3' })).toBe(3);
  });

  test('a garbage advisory is ignored, never a crash', () => {
    writeAdvisory('lots');
    expect(workers(4)).toBe(4);
  });
});
