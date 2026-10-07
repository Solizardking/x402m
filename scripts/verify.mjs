// One entry point for source contracts, Node, Python and Pay Kit communication.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const all = process.argv.includes('--kotlin');
if (process.argv.slice(2).some(arg => arg !== '--kotlin')) throw new Error('Usage: node scripts/verify.mjs [--kotlin]');
const env = { ...process.env };
// Verification never uses a user's live identity, wallet or provider secrets.
for (const key of Object.keys(env)) if (/^(X402M_|XAI_|OWS_|MPP_HARNESS_|X402_HARNESS_)/.test(key)) delete env[key];
const run = (command, args, extra = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
});
const python = folder => path.join(root, folder, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
try {
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test']);
  await run('uv', ['sync', '--project', 'python/x402m', '--extra', 'test', '--frozen', '--python', '3.12']);
  await run(python('python/x402m'), ['-m', 'pytest', 'python/x402m/tests', 'integration/test_mailbox.py', '-q']);
  await run(python('python/x402m'), ['python/examples/channel_demo.py']);
  await run('uv', ['sync', '--project', 'harness', '--frozen', '--python', '3.12']);
  if (all) {
    const gradle = env.GRADLE_BIN || 'gradle';
    const java = {};
    if (process.platform === 'darwin' && !env.JAVA_HOME) {
      try { java.JAVA_HOME = execFileSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' }).trim(); } catch {}
    }
    // Both composite builds write the same SDK output, so run sequentially.
    for (const name of ['kotlin-x402-client', 'kotlin-x402-upto-client']) {
      await run(gradle, ['-p', `harness/${name}`, '--no-daemon', '-Pkotlin.compiler.execution.strategy=in-process', 'installDist'], java);
    }
  }
  // Require explicitly requested Kotlin runs; the Python-only mode omits JVM cases.
  const args = ['-m', 'pytest', 'harness/tests', 'harness/python-server/test_harness_adapter.py', '-q'];
  if (!all) args.push('-k', 'not kotlin');
  await run(python('harness'), args, all ? { MUSEBOOK_TEST_KOTLIN: '1' } : {});
  console.log(all ? 'Verified Node, Python, Cloudflare mailbox and Python/Kotlin harness communication.'
    : 'Verified Node, Python, Cloudflare mailbox and Python harness communication. Use verify:all for Kotlin.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
