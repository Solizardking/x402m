import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { descriptor } from '../cloudflare/x402m.mjs';
import { X402M_CAPABILITIES } from '../x402m-bot/capabilities.mjs';
import { documentationResources, readDocumentationResource } from '../x402m-bot/documentation.mjs';

const root = new URL('../', import.meta.url);
test('portable Node capability contract matches Cloudflare mailbox', () => {
  assert.deepEqual(X402M_CAPABILITIES, descriptor().capabilities);
});

test('bundled MCP documentation matches canonical workspace docs', async () => {
  for (const resource of documentationResources) {
    let expected = await readFile(new URL(`docs/${resource.name}`, root), 'utf8');
    expected = expected.replaceAll('../x402m-bot/', '../')
      .replaceAll('../cloudflare/', 'https://github.com/Solizardking/x402m/blob/main/cloudflare/');
    for (const directory of ['schemes', 'spec', 'python']) expected = expected.replaceAll(`../${directory}/`, `https://github.com/Solizardking/x402m/blob/main/${directory}/`);
    assert.equal((await readDocumentationResource(resource.uri)).text, expected, resource.name);
  }
});

test('main README maps every requested workspace area and its local links resolve', async () => {
  const text = await readFile(new URL('README.md', root), 'utf8');
  for (const name of ['.github', '.github/workflows', '.playwright-mcp', '.pytest_cache', 'a2a-x402-main',
    'cloudflare', 'docs', 'examples', 'harness', 'node_modules', 'pay-kit-main', 'python', 'schemes', 'spec',
    'x402m-bot', '.gitignore', 'CONTRIBUTING.md', 'LICENSE', 'package-lock.json', 'package.json', 'README.md', 'SECURITY.md']) {
    assert.ok(text.includes(name), `Missing workspace mapping: ${name}`);
  }
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || target.includes('://')) continue;
    assert.ok(existsSync(new URL(target, root)), `Broken README link: ${target}`);
  }
});
