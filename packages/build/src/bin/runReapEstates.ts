#!/usr/bin/env node

import { reapEstates } from '../reapEstates';

reapEstates().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
