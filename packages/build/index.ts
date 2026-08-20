/**
 * Library surface of @proteinjs/build. The workspace commands themselves ship as bins; what is
 * exported here is the shared core other tooling consumes directly — e.g. the n3xa dev skill's
 * workspace-management tools wrap WorktreeCleaner (the same classifier the clean-worktrees CLI
 * runs) for the workspaces/worktrees the skill manages.
 */
export * from './src/WorktreeCleaner';
