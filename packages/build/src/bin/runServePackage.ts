#!/usr/bin/env node

import { servePackage } from '../servePackage';

servePackage().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
