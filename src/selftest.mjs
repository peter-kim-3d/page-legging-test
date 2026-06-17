#!/usr/bin/env node
// src/selftest.mjs — fast offline self-check (no network, no LLM, no Chrome).
// Verifies the security gate and the decision-tree classifier still work on a
// new machine. Run with: npm test

import { assertNoSensitive, buildSanitizedSummary } from './sanitize.mjs';
import { diagnosePage, classifyRequest } from './diagnose.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails += 1; };
const r = (timings) => ({ method: 'GET', host: 'h', path: '/x', status: 200, timings });

// 1) Security gate must throw on a forbidden key.
let threw = false;
try { assertNoSensitive({ requests: [{ path: '/x', headers: { cookie: 'secret' } }] }); }
catch { threw = true; }
ok(threw, 'sanitizer gate blocks a forbidden key (headers/cookie)');

// 2) Sanitizer strips query strings to path-only.
const sum = buildSanitizedSummary({ source: 'test', target: 'https://h/p?token=SECRET', runs: 1, requests: [], pageMetrics: {} });
ok(!JSON.stringify(sum).includes('SECRET'), 'sanitizer drops query-string secrets');

// 3) Decision tree maps the dominant phase to the right layer.
const layerOf = (timings) => diagnosePage([r(timings)], {}).layer;
ok(layerOf({ wait: 2000, total: 2100, receive: 50, blocked: 0, dns: 0, connect: 0, ssl: 0, send: 0 }) === 'backend', 'dominant wait -> backend');
ok(layerOf({ receive: 3000, total: 3100, wait: 50, blocked: 0, dns: 0, connect: 0, ssl: 0, send: 0 }) === 'payload', 'dominant receive -> payload');
ok(layerOf({ blocked: 1800, total: 1900, wait: 40, dns: 0, connect: 0, ssl: 0, send: 0, receive: 60 }) === 'connection', 'dominant blocked -> connection');
ok(layerOf({ connect: 2000, total: 2100, wait: 40, blocked: 0, dns: 0, ssl: 0, send: 0, receive: 60 }) === 'network', 'dominant connect -> network');

// 4) Sub-threshold warm reads are 'cached', not a bottleneck layer.
ok(classifyRequest({ timings: { wait: 1, total: 1 } }).layer === 'cached', 'sub-50ms request -> cached');

console.log(fails ? `\n${fails} test(s) FAILED` : '\nAll self-tests passed.');
process.exit(fails ? 1 : 0);
