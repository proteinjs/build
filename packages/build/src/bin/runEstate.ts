#!/usr/bin/env node

import { estate } from '../estate';

estate().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
