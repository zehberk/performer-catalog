#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

function waitForListeningFromServer(server, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Proxy did not start in time')), timeoutMs);

    server.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (text.includes('Playwright proxy listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function runCheck() {
  let server = null;
  let spawned = false;

  try {
    // Try existing proxy first
    try {
      const res = await globalThis.fetch('http://localhost:3789/fetch?url=https://example.com');
      const body = await res.text();

      if (res.ok && body.includes('Example Domain')) {
        console.log('Proxy check passed (existing proxy)');
        return process.exit(0);
      }

      console.warn(
        'Existing proxy returned non-OK or unexpected body; will spawn temporary proxy. status=',
        res.status,
      );
      console.warn('Snippet:', body.slice(0, 400));
      // fall through to spawn temporary proxy
    } catch {
      // Not running or existing proxy is broken — spawn a temporary proxy on alternate port
      const altPort = 3790;
      server = spawn(process.execPath, [serverPath], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, PORT: String(altPort) },
      });
      spawned = true;
      await waitForListeningFromServer(server);

      const res = await globalThis.fetch(
        `http://localhost:${altPort}/fetch?url=https://example.com`,
      );
      const body = await res.text();

      if (body.includes('Example Domain')) {
        console.log('Proxy check passed (spawned proxy)');
        return process.exit(0);
      }

      console.error('Proxy check failed: unexpected body');
      return process.exit(2);
    }
  } catch (err) {
    console.error('Proxy check error', err);
    return process.exit(1);
  } finally {
    if (spawned && server) {
      server.kill();
    }
  }
}

runCheck();
