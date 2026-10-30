import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--experimental-strip-types', '--watch', 'apps/api/src/server.ts'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web'], { stdio: 'inherit' })
];
function stop() { for (const child of children) child.kill(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code !== 0) { stop(); process.exitCode = code || 1; } });
