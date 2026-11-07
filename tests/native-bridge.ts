import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NativeBackend } from '../packages/storage/src/native.ts';

/** Opt-in shared contract tests against the real Rust SQLite engine, not a mock. */
export function nativeTestBackend(beforeSend?: (request: Record<string, unknown>) => void): NativeBackend {
  const [command, ...args] = JSON.parse(process.env.MAVYN_STORAGE_BRIDGE!) as string[];
  if (!command) throw new Error('MAVYN_STORAGE_BRIDGE must be a JSON command array');
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const reply = JSON.parse(line) as { id: number; value?: unknown; error?: unknown };
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) request?.reject(reply.error); else request?.resolve(reply.value);
  });
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('exit', (code) => fail(new Error(`SQLite test bridge exited: ${code}`)));
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
  // Vitest workers exit after the suite; children must not survive the worker.
  const stop = () => { child.kill(); };
  process.once('exit', stop);
  return new NativeBackend((request) => new Promise((resolve, reject) => {
    beforeSend?.(request);
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, request }) + '\n', (error) => { if (error) { pending.delete(id); reject(error); } });
  }), () => { process.removeListener('exit', stop); reader.close(); child.stdin.end(); });
}
