/**
 * Library surface of @proteinjs/build. The workspace commands themselves ship as bins; what is
 * exported here is the shared core other tooling consumes directly — e.g. the n3xa dev skill's
 * workspace-management tools wrap WorktreeCleaner (the same classifier the clean-worktrees CLI
 * runs) for the workspaces/worktrees the skill manages.
 */
export * from './src/WorktreeCleaner';
// The local estate machinery (RESOURCE_GOVERNANCE §B): the dev skill's workspace tooling wraps
// the same cores the estate/reap-estates/estate-watchdog/docker-repair CLIs run.
export * from './src/EstateRegistry';
export * from './src/EstateReaper';
export * from './src/PressureValve';
export * from './src/DockerGuardian';
export * from './src/LogGovernor';
