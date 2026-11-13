#!/usr/bin/env node
// Top self-time functions of a Chrome .cpuprofile: node tools/perf/summarize-profile.mjs file [topN]
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const top = Number(process.argv[3] || 25);
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
const agg = new Map();
let total = 0;
for (const [id, us] of self) {
  const c = byId.get(id).callFrame;
  const k = `${c.functionName || '(anon)'} ${c.url.split('/').slice(-1)[0].slice(0, 28)}:${c.lineNumber}`;
  agg.set(k, (agg.get(k) || 0) + us); total += us;
}
console.log(`total sampled ${(total / 1000).toFixed(0)} ms`);
for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(us / 1000).toFixed(1).padStart(8)} ms  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
