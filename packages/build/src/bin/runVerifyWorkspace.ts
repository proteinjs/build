#!/usr/bin/env node

import { verifyWorkspace } from '../verifyWorkspace';

verifyWorkspace().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
