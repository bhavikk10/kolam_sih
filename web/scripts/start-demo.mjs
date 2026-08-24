import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = fileURLToPath(new URL('..', import.meta.url));

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(450, () => finish(false));
  });
}

async function listening(port) {
  return (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'));
}

function launch(name) {
  const child = spawn(`${npm} run ${name}`, { cwd: root, stdio: 'inherit', shell: true });
  child.once('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
  return child;
}

const children = [];
const apiRunning = await listening(8000);
const webRunning = await listening(3000);

if (apiRunning) console.log('API already available on http://127.0.0.1:8000 — reusing it.');
else children.push(launch('api'));

if (webRunning) console.log('Site already available on http://localhost:3000 — reusing it.');
else children.push(launch('dev'));

if (!children.length) process.exit(0);

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
