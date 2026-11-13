import { spawn } from 'node:child_process';
import { php, phpArgs } from './php-runtime.mjs';
const child = spawn(php, [...phpArgs, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
