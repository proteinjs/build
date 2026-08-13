#!/usr/bin/env node

import { pullForward } from '../pullForward';

pullForward().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
