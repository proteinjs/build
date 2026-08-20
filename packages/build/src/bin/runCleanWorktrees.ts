#!/usr/bin/env node

import { cleanWorktrees } from '../cleanWorktrees';

cleanWorktrees().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
