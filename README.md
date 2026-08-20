# Overview

A set of tools for managing workspace build operations, working directly on top of npm. No config required to use.

## How to use

1. Install as a dev dependency of your workspace root package `npm i --save-dev @proteinjs/build`
2. The following commands are now available
    - `npx build-workspace` runs `npm install` and `npm run build` for each package, in dependency order, until the workspace is built
    - `npx watch-workspace` runs `npm run watch` for each package
    - `npx workspace <command>` runs `npm run <command>` for each package

**Note:** if a script is not defined for a package (ie. `build`|`test`|`watch`), the package will be skipped when running the workspace command instead of failing.

## How it works

- Each script searches recursively for local packages, starting in the directory you executed the command in, and builds a dependency graph used for command sequencing.
- During the install phase, it creates symlinks to local dependencies.
    - Local dependencies are determined by the filesystem search, not by the dependency version specified in the package.json.
    - This is useful for being able to specify explicit dependency versions for publishing, while also being able to build from local source during development. It all just works.
    - Note: if publishing packages, keep in mind that the package must be published first before any package can depend on the explicit version and leverage the symlinking of this library. This is because `npm i` is first executed, and then symlinks are created afterwards, blowing away the version installed from the registry. The `npm i` command will fail (per usual) if your package depends on an explicit version of a package that doesn't exist in the registry.
## Worktree lifecycle: `clean-worktrees`

Worktree cleanup is part of the release process (metarepo PROCESS.md, "Temp and workspace
hygiene", ruled 2026-08-20): a lane worktree is reclaimable the moment its commits are
train-visible — commits live in the repo's shared object store, so deleting a worktree never
deletes commits. Train close-out runs the sweep + `git worktree prune` across touched repos.

`npx clean-worktrees` (or `npm run clean-worktrees` from a workspace root that wires it)
enumerates worktrees across every repo under the workspace plus the session-scratchpad
convention roots, classifies each one, and reports:

- **safe** — tip commit verified in the object store, no uncommitted non-lockfile dirt, not
  pinned. Lockfile-only dirt counts as clean (local lock regens are never shipped).
- **pinned** — never removed: primary checkouts, git-locked worktrees, uncommitted real dirt,
  a live process holding paths inside (one lsof pass), `--keep` paths, or a `.worktree-keep`
  marker file at the worktree root.
- **unknown** — reported, never touched: broken registrations, git failures, or an unavailable
  process-hold snapshot.

Default is a dry-run report with measured (`du`) sizes — reclaim totals are never estimated.
`--apply` removes the safe worktrees and prunes registrations. See `npx clean-worktrees --help`.

The classifier/sweeper core is exported as `WorktreeCleaner` from this package's library
surface. The n3xa dev skill's workspace model inherits this same lifecycle: its
workspace-management tooling is a second door over the same `WorktreeCleaner` core for the
workspaces/worktrees the skill manages — this CLI is the operator door.
