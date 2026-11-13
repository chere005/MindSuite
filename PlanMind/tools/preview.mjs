import { fixture, password } from './fixture.mjs';
import { rm } from 'node:fs/promises';
const preview = await fixture(Number(process.env.PLANMIND_PORT || 5187));
console.log(`Local: ${preview.url}\nDisposable preview accounts: alex / sam. Password: ${password}`);
const stop = async () => { preview.server.kill(); await rm(preview.dir, { recursive: true, force: true }); process.exit(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
preview.server.on('exit', code => process.exit(code ?? 0));
