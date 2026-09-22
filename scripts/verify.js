#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {verifyBundle} from '../public/core/audit.js';
const [file, expectedHead] = process.argv.slice(2);
if (!file) { console.error('Usage: npm run verify -- path/to/audit.json [trusted-head-sha256]'); process.exit(2); }
try {
  const bundle = JSON.parse(await readFile(file, 'utf8'));
  const report = await verifyBundle(bundle, {expectedHead: expectedHead || null});
  const {state, ...summary} = report;
  console.log(JSON.stringify({...summary, humanScore: state.human.score, jevScore: state.jev.score,
    warning: expectedHead ? null : 'No independently trusted head was supplied; this checks internal consistency.'}, null, 2));
} catch (error) { console.error(JSON.stringify({ok: false, error: error.message})); process.exit(1); }
