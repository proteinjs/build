import { PackageProcessOptions, PackageProcessRunner } from './PackageProcessRunner';

/**
 * The formatter pass a package gets after its build — `prettier . --write`, then `eslint . --fix`
 * — and the one owner of its argv: `build-workspace` (on CI, or `--lint`) runs it through its
 * process runner; `lint-workspace` runs the same argv itself.
 *
 * Recorded test fixtures are bytes, never sources: a test that compares its subject against a
 * recording byte for byte must find the recording exactly as committed, so the pass excludes
 * `test/fixtures/**` in every package by construction — no package has to remember to list it in
 * its own ignore file. Generated code is the same class: `generated/` is a build's output (the
 * reflection build emits its index there, after which nothing reads it as a source), never
 * hand-formatted, so the pass excludes `generated/**` the same way — a repository-level ignore
 * file does not cover it (prettier reads `.gitignore` and `.prettierignore` from the package
 * directory it runs in, never from a parent), and a build output is not a source to lint. The
 * exclusions ride beside the package's own ignore files, never in place of them: prettier takes
 * them as negated patterns next to `.` (its default `.prettierignore` and `.gitignore` reading is
 * untouched), eslint as `--ignore-pattern` (`.eslintignore` and `ignorePatterns` untouched).
 *
 * A consumer that proves the pass would rewrite nothing runs the same prettier argv in its
 * read-only form (`prettierArgs('check')`) — the one owner of the argv, in both forms.
 */
export class PackageFormatter {
  /** package-relative globs the pass never formats, in every package */
  static readonly EXCLUDED_GLOBS: readonly string[] = ['test/fixtures/**', 'generated/**'];

  constructor(private readonly runner: PackageProcessRunner) {}

  async format(options: PackageProcessOptions): Promise<void> {
    await this.runner.run('npx', PackageFormatter.prettierArgs(), options);
    await this.runner.run('npx', PackageFormatter.eslintArgs(), options);
  }

  /** `prettier . !<glob>… --write` — or `--check`, the same pass read-only */
  static prettierArgs(action: 'write' | 'check' = 'write'): string[] {
    const args = ['prettier', '.'];
    for (const glob of PackageFormatter.EXCLUDED_GLOBS) {
      args.push(`!${glob}`);
    }
    args.push(`--${action}`);
    return args;
  }

  /** `eslint . --ignore-pattern <glob>… --fix` */
  static eslintArgs(): string[] {
    const args = ['eslint', '.'];
    for (const glob of PackageFormatter.EXCLUDED_GLOBS) {
      args.push('--ignore-pattern', glob);
    }
    args.push('--fix');
    return args;
  }
}
