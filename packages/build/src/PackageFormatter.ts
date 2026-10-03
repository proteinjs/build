import { PackageProcessOptions, PackageProcessRunner } from './PackageProcessRunner';

/**
 * The formatter pass a package gets after its build — `prettier . --write`, then `eslint . --fix`
 * — and the one owner of its argv: `build-workspace` (on CI, or `--lint`) runs it through its
 * process runner; `lint-workspace` runs the same argv itself.
 *
 * Recorded test fixtures are bytes, never sources: a test that compares its subject against a
 * recording byte for byte must find the recording exactly as committed, so the pass excludes
 * `test/fixtures/**` in every package by construction — no package has to remember to list it in
 * its own ignore file. The exclusion rides beside the package's own ignore files, never in place
 * of them: prettier takes it as a negated pattern next to `.` (its default `.prettierignore` and
 * `.gitignore` reading is untouched), eslint as `--ignore-pattern` (`.eslintignore` and
 * `ignorePatterns` untouched).
 */
export class PackageFormatter {
  /** package-relative globs the pass never formats, in every package */
  static readonly EXCLUDED_GLOBS: readonly string[] = ['test/fixtures/**'];

  constructor(private readonly runner: PackageProcessRunner) {}

  async format(options: PackageProcessOptions): Promise<void> {
    await this.runner.run('npx', PackageFormatter.prettierArgs(), options);
    await this.runner.run('npx', PackageFormatter.eslintArgs(), options);
  }

  /** `prettier . !<glob>… --write` */
  static prettierArgs(): string[] {
    const args = ['prettier', '.'];
    for (const glob of PackageFormatter.EXCLUDED_GLOBS) {
      args.push(`!${glob}`);
    }
    args.push('--write');
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
