'use strict';
// The preset's own suite runs THROUGH the preset (relative-path form) so `jest` here also
// proves the entry file loads under real jest with the real installed ts-jest. The tests
// themselves are plain .js — the ts transform never fires for them.
module.exports = {
  preset: './jest-preset.js',
  roots: ['<rootDir>/test'],
  // Named override: this package's own suite is plain JS (the preset is buildless JS), so the
  // inherited ts?(x) testMatch would find nothing.
  testMatch: ['**/?(*.)+(spec|test).js'],
};
