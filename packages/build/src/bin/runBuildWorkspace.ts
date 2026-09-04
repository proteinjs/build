#!/usr/bin/env node

import { buildWorkspace } from '../buildWorkspace';

buildWorkspace().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
