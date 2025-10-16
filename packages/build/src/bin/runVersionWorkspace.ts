#!/usr/bin/env node

import { versionWorkspace } from '../versionWorkspace';

function getDryRunFlag() {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run')) {
    return true;
  }

  const envFlag = process.env.VERSION_WORKSPACE_DRY_RUN ?? process.env.DRY_RUN;
  if (envFlag) {
    return envFlag === 'true' || envFlag === '1';
  }

  return false;
}

void versionWorkspace({ dryRun: getDryRunFlag() });
