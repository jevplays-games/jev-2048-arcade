#!/usr/bin/env node
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {analyze, csv} from '../public/core/analytics.js';
import {verifyBundle} from '../public/core/audit.js';
const [file, destination = 'exports'] = process.argv.slice(2);
if (!file) { console.error('Usage: npm run export -- audit.json output-directory'); process.exit(2); }
try {
  const bundle = JSON.parse(await readFile(file, 'utf8')), verification = await verifyBundle(bundle), analytics = analyze(bundle);
  analytics.integrity = {checked: true, ...verification, state: undefined};
  const directory = resolve(destination); await mkdir(directory, {recursive: true});
  const answers = [], requests = [];
  for (const event of bundle.events) {
    if (event.type === 'jev_response') {
      const d = event.data;
      requests.push({eventSeq: event.seq, requestHash: d.requestHash, attempt: d.attempt,
        httpStatus: d.httpStatus, latencyMs: d.latencyMs, model: d.response?.model ?? null,
        inputTokens: d.response?.usage?.input_tokens ?? null, outputTokens: d.response?.usage?.output_tokens ?? null});
      for (const [question, a] of Object.entries(d.response?.answers || {}))
        for (const [level, probability] of Object.entries(a.probabilities || {})) answers.push({eventSeq: event.seq,
          requestHash: d.requestHash, question, level, probability, score: a.score, confidence: a.confidence,
          description: a.legend?.[level] ?? null});
    }
  }
  const tables = {moves: analytics.roundRows, candidates: analytics.candidateRows, cells: analytics.cellRows,
    answers, requests, telemetry: bundle.telemetry || []};
  for (const [name, rows] of Object.entries(tables)) {
    await writeFile(resolve(directory, name + '.csv'), csv(rows));
    await writeFile(resolve(directory, name + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }
  await writeFile(resolve(directory, 'events.jsonl'), bundle.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(resolve(directory, 'analytics.json'), JSON.stringify(analytics, null, 2));
  await writeFile(resolve(directory, 'verification.json'), JSON.stringify(verification, null, 2));
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2));
  console.log(JSON.stringify({directory, verified: true, rows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]))}, null, 2));
} catch (error) { console.error(error.message); process.exit(1); }
