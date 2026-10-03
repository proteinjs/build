import { WorkspaceFixture } from './WorkspaceFixture';

/**
 * The formatter pass (prettier --write + eslint --fix after a build that ran, on CI or `--lint`)
 * formats a package's sources and never its recorded test fixtures: a recording under
 * `test/fixtures` is bytes a test compares its subject against, byte for byte, so the pass
 * leaves it exactly as committed — in every package, by construction, never by each package's
 * own ignore file. Every assertion is an OUTCOME: the bytes of each file after the real pass ran.
 */
describe('the formatter pass', () => {
  // A real build plus real `npx prettier` and `npx eslint` runs (≈ 1 s each).
  jest.setTimeout(120_000);
  let fixture: WorkspaceFixture;
  const name = 'p';
  const args = { noInstall: ['@test/p'] };
  // Unformatted on purpose: either tool would rewrite each of these if it reached them.
  const recordingHtml = '<div><p>one line</p><p>no trailing newline</p></div>';
  const recordingJs = 'let   recorded=1';
  const generatedJs = 'let   generated=1';

  beforeEach(async () => {
    fixture = await WorkspaceFixture.create();
    await fixture.linkFormatterBins();
    await fixture.addPackage(name);
    await fixture.writeFile(name, '.prettierrc', '{ "singleQuote": true }\n');
    await fixture.writeFile(name, '.prettierignore', 'dist/\ngenerated.js\n');
    await fixture.writeFile(
      name,
      '.eslintrc.json',
      JSON.stringify({ root: true, parserOptions: { ecmaVersion: 2020 }, rules: { 'prefer-const': 'warn' } }) + '\n'
    );
    await fixture.writeFile(name, '.eslintignore', 'dist/\ngenerated.js\n');
    await fixture.writeFile(name, 'src/a.ts', 'export const a=1;export const b  = "x"\n');
    await fixture.writeFile(name, 'src/b.js', 'let b = 1;\nmodule.exports = { b };\n');
    await fixture.writeFile(name, 'test/fixtures/recording.html', recordingHtml);
    await fixture.writeFile(name, 'test/fixtures/recording.js', recordingJs);
    await fixture.writeFile(name, 'generated.js', generatedJs);
    fixture.commit();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it('formats the sources and leaves every recording under test/fixtures byte-identical', async () => {
    const summary = await fixture.run({ args, lintEnabled: true });

    expect(summary.linted).toEqual(['@test/p']);
    // prettier rewrote the TypeScript source; eslint --fix rewrote the JavaScript one (let → const).
    expect(await fixture.readFile(name, 'src/a.ts')).toBe("export const a = 1;\nexport const b = 'x';\n");
    expect(await fixture.readFile(name, 'src/b.js')).toBe('const b = 1;\nmodule.exports = { b };\n');
    // The recordings are exactly as committed: neither tool reached them.
    expect(await fixture.readFile(name, 'test/fixtures/recording.html')).toBe(recordingHtml);
    expect(await fixture.readFile(name, 'test/fixtures/recording.js')).toBe(recordingJs);
  });

  it("the package's own ignore files still hold beside the exclusion", async () => {
    await fixture.run({ args, lintEnabled: true });

    expect(await fixture.readFile(name, 'generated.js')).toBe(generatedJs);
  });
});
