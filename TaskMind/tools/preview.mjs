import { fixture, password } from './fixture.mjs';
import { rm } from 'node:fs/promises';
const preview = await fixture(Number(process.env.TASKMIND_PORT || 8870));
console.log(`Local: ${preview.url}\nDisposable preview accounts: alex (owner), sam (admin), outsider (not on the team). Password: ${password}`);
const stop = async () => { preview.server.kill(); await rm(preview.dir, { recursive: true, force: true }); process.exit(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
preview.server.on('exit', code => process.exit(code ?? 0));
