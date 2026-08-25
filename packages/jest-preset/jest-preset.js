'use strict';
// The module jest resolves for `preset: '@proteinjs/jest-preset'`. See JestPresetBuilder for
// what the preset carries and why.
const { JestPresetBuilder } = require('./JestPresetBuilder');

module.exports = new JestPresetBuilder().build();
