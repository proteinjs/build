#!/usr/bin/env node

import { estateWatchdog } from '../estateWatchdog';

estateWatchdog().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
