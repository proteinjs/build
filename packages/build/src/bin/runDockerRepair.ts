#!/usr/bin/env node

import { dockerRepair } from '../dockerRepair';

dockerRepair().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
