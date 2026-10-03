import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { enrollWithSession } from './enrollment.mjs';
const path = process.env.X402M_SIWS_SESSION_FILE;
if (!path) throw new Error('Set X402M_SIWS_SESSION_FILE to a private file containing a current SIWS session token, or use node connect.mjs for browser enrollment');
if ((await stat(path)).mode & 0o077) throw new Error('Session file must have mode 600');
const result = await enrollWithSession({ session: (await readFile(path, 'utf8')).trim(), name: process.argv[2] || 'Grok Bot', dir: resolve(process.argv[3] || './identity') });
console.log(JSON.stringify({ ...result, next: 'Open the approval URL, compare the code, and approve only the listed messaging scopes.' }, null, 2));
