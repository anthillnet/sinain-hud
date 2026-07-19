#!/usr/bin/env node

process.argv.splice(2, 0, 'claude');
await import('./install.mjs');
