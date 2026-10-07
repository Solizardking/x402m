"""Node ↔ Python signed HTTP roundtrip using real Cloudflare SQL dispatcher."""
import json
import os
import selectors
import shutil
import subprocess
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from x402m import X402mClient
from x402m.core.client import encode

ROOT = Path(__file__).resolve().parents[1]


def read_line(process):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(10):
            raise AssertionError('fixture response timed out')
    line = process.stdout.readline()
    assert line, 'fixture exited before its response'
    return json.loads(line)


def node_call(process, capability, arguments=None):
    process.stdin.write(json.dumps({'capability': capability, 'arguments': arguments or {}}) + '\n')
    process.stdin.flush()
    result = read_line(process)
    assert 'error' not in result, result.get('error')
    return result['result']


@pytest.mark.asyncio
async def test_node_python_cloudflare_request_reply_ack(tmp_path):
    node = shutil.which('node')
    assert node, 'Node 24+ required for cross-language integration'
    keys = {name: Ed25519PrivateKey.generate() for name in ['fixture-node', 'fixture-python']}
    public = {}
    for name, key in keys.items():
        jwk = {'kty': 'OKP', 'crv': 'Ed25519', 'x': encode(key.public_key().public_bytes_raw())}
        public[name] = jwk
        private = tmp_path / (name + '.private.jwk')
        private.write_text(json.dumps({**jwk, 'd': encode(key.private_bytes_raw())})); private.chmod(0o600)
    public_file = tmp_path / 'public.json'; public_file.write_text(json.dumps(public))
    env = {'PATH': os.environ.get('PATH', ''), 'X402M_AGENT_ID': 'fixture-node',
           'X402M_KEY_FILE': str(tmp_path / 'fixture-node.private.jwk')}
    process = subprocess.Popen([node, str(ROOT / 'integration/mailbox-fixture.mjs'), str(public_file)],
                               env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        ready = read_line(process)
        async with X402mClient('fixture-python', keys['fixture-python'], provider=ready['provider']) as python:
            assert node_call(process, 'discover')['protocol'] == 'x402m/1'
            assert (await python.discover())['protocol']['protocol'] == 'x402m/1'
            node_call(process, 'x402m.register', {'handle': 'node-fixture', 'name': 'Node fixture'})
            await python.execute('x402m.register', {'handle': 'python-fixture', 'name': 'Python fixture'})
            arguments = {'to': '@python-fixture', 'requestId': 'roundtrip-1', 'kind': 'request', 'content': 'Explain escrow commitments: 雪 🦀'}
            sent = node_call(process, 'x402m.send', arguments)
            assert node_call(process, 'x402m.send', arguments)['duplicate'] is True
            inbox = await python.execute('x402m.inbox', {'after': 0})
            assert len(inbox['messages']) == 1
            message = inbox['messages'][0]
            assert message['id'] == sent['id'] and message['content'] == arguments['content']
            assert message['sender'] == 'fixture-node'
            assert 'fingerprint' not in message and 'request_id' not in message
            reply = await python.execute('x402m.send', {'to': message['sender'], 'requestId': 'reply-1',
                'replyTo': message['id'], 'kind': 'response', 'content': 'A commitment is not an immediate payout.'})
            received = node_call(process, 'x402m.inbox')['messages']
            assert len(received) == 1 and received[0]['id'] == reply['id']
            assert received[0]['reply_to'] == message['id'] and received[0]['conversation_id'] == 'roundtrip-1'
            node_call(process, 'x402m.ack', {'id': reply['id']})
            await python.execute('x402m.ack', {'id': message['id']})
            assert not node_call(process, 'x402m.inbox')['messages']
            assert not (await python.execute('x402m.inbox'))['messages']
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        for stream in [process.stdin, process.stdout, process.stderr]: stream.close()
