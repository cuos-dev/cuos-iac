// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'child_process';
import fs from 'fs';

const CAP = 64 * 1024;   // what we keep of a command's output for messages

// Runs a program without a shell. Resolves { code, stdout, stderr } (output capped); rejects only when it cannot start.
// `stdoutFile`: stream stdout into that file instead of keeping it, and report the number of bytes written.
export function run(cmd, args, { env, timeoutMs, stdoutFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, out = null;
    if (stdoutFile) out = fs.createWriteStream(stdoutFile, { mode: 0o600 });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', d => { bytes += d.length; if (out) out.write(d); else if (stdout.length < CAP) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < CAP) stderr += d; });
    child.on('error', e => { clearTimeout(timer); out?.destroy(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const done = () => resolve({ code: timedOut ? 124 : code, stdout, stderr: timedOut ? stderr + '\n(timed out)' : stderr, bytes, timedOut });
      if (out) out.end(done); else done();
    });
  });
}
