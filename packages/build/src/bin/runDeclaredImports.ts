#!/usr/bin/env node
/**
 * declared-imports — the CLI door of the declared-imports law (src/DeclaredImports.ts): every package an
 * import names is a dependency the importing package declares.
 *
 *   declared-imports --check [--root <dir>]
 *
 * Exit 0 clean (`declared-imports: N packages, M files, 0 undeclared`) · 1 undeclared imports, one line each
 * grouped by package (`<package>  <file>:<line>  <specifier> → undeclared '<name>'`) · 2 usage, or a root that
 * is neither a workspace nor a package. A repo's _test.yml runs it before the build; a lane runs it in its
 * worktree; a metarepo's land stage runs the same class over the composed tip.
 */
import { DeclaredImports } from '../DeclaredImports';

process.exitCode = DeclaredImports.cli(process.argv.slice(2), (line) => console.log(line));
