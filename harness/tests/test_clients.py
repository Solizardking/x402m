"""Loopback transport/crypto fixtures. No Solana broadcast or funded settlement."""
import base64
import json
import os
import selectors
import subprocess
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solders.message import to_bytes_versioned

ROOT = Path(__file__).resolve().parents[2]
NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
BLOCKHASH = "11111111111111111111111111111111"


@contextmanager
def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def environment(**values):
    # Fixture-only subprocesses do not inherit provider/wallet credentials.
    env = {"PATH": os.environ.get("PATH", ""), **values}
    java_home = os.environ.get("JAVA_HOME")
    local_jdk = Path("/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home")
    if java_home:
        env["JAVA_HOME"] = java_home
    elif local_jdk.exists():
        env["JAVA_HOME"] = str(local_jdk)
    return env


class RpcFixture(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        assert request["method"] == "getLatestBlockhash", "fixture must never broadcast"
        body = json.dumps({"jsonrpc": "2.0", "id": request.get("id", 1), "result": {
            "context": {"slot": 341000000}, "value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 341000100}}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)


def command(language, scheme):
    directory = f"{language}-x402" + ("-upto" if scheme == "upto" else "") + "-client"
    if language == "python":
        return [sys.executable, str(ROOT / "harness" / directory / "main.py")]
    name = "musebook-kotlin-x402" + ("-upto" if scheme == "upto" else "") + "-harness-client"
    binary = ROOT / "harness" / directory / "build/install" / name / "bin" / name
    if not binary.exists():
        if os.environ.get("MUSEBOOK_TEST_KOTLIN") == "1":
            pytest.fail("Build both Kotlin installDist targets before this suite")
        pytest.skip("Kotlin installDist not built; set MUSEBOOK_TEST_KOTLIN=1 to require it")
    return [str(binary)]


@pytest.mark.parametrize("language", ["python", "kotlin"])
@pytest.mark.parametrize("scheme", ["exact", "upto"])
@pytest.mark.parametrize("mismatch", [False, True])
def test_paid_client_signed_wire_and_no_authorization_in_output(language, scheme, mismatch):
    run = command(language, scheme)
    payer, sponsor, receiver, authorizer = [Keypair() for _ in range(4)]
    requirement = {"scheme": scheme, "network": NETWORK, "asset": MINT, "amount": "1000",
                   "payTo": str(receiver.pubkey()), "maxTimeoutSeconds": 300,
                   "extra": {"feePayer": str(sponsor.pubkey()), "decimals": 6,
                    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    "recentBlockhash": BLOCKHASH, "recentSlot": 341000000, "memo": "musebook-fixture"}}
    if scheme == "upto":
        requirement["extra"].update(receiverAuthorizer=str(authorizer.pubkey()), withdrawDelay=900, assetTransferMethod="payment-channel")
    if mismatch:
        requirement["network"] = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    state = {"verified": False, "error": None}
    class Resource(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            authorization = self.headers.get("payment-signature")
            if not authorization:
                body = {"x402Version": 2, "accepts": [requirement]}
                self.send_response(402)
                self.send_header("payment-required", base64.b64encode(json.dumps(body).encode()).decode())
            else:
                try:
                    payment = json.loads(base64.b64decode(authorization))
                    assert payment["x402Version"] == 2
                    assert payment["accepted"] == requirement
                    wire = payment["payload"]["transaction" if scheme == "exact" else "openTransaction"]
                    tx = VersionedTransaction.from_bytes(base64.b64decode(wire))
                    assert tx.message.account_keys[0] == sponsor.pubkey()
                    index = list(tx.message.account_keys).index(payer.pubkey())
                    assert tx.signatures[index].verify(payer.pubkey(), to_bytes_versioned(tx.message))
                    assert not tx.message.address_table_lookups
                    if scheme == "exact":
                        from solana_pay_kit.protocols.x402.exact.verify import ExactVerifier
                        assert ExactVerifier.verify(wire, requirement, [str(sponsor.pubkey())])["amount"] == 1000
                    else:
                        from solana_pay_kit._paycore.paymentchannels import PAYMENT_CHANNELS_PROGRAM_ID, find_channel_pda
                        from solders.pubkey import Pubkey
                        payload = payment["payload"]
                        expected, _ = find_channel_pda(payer.pubkey(), sponsor.pubkey(), Pubkey.from_string(MINT), authorizer.pubkey(), int(payload["nonce"]), 341000000, Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID))
                        assert payload["channelId"] == str(expected)
                        assert payload["maxAmount"] == payload["deposit"] == "1000"
                    state["verified"] = True
                    self.send_response(200)
                    body = {"ok": True, "evidence": "signed-wire-fixture-only"}
                except Exception as error:
                    state["error"] = str(error)
                    self.send_response(400); body = {"error": "fixture rejected"}
            self.send_header("content-type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps(body).encode())
    with serve(Resource) as target:
        result = subprocess.run(run, env=environment(X402_HARNESS_TARGET_URL=target+"/protected", X402_HARNESS_RPC_URL=target,
                                X402_HARNESS_NETWORK=NETWORK, X402_HARNESS_CLIENT_SECRET_KEY=json.dumps(list(bytes(payer)))),
                                capture_output=True, text=True, timeout=30)
    assert result.returncode in ((0, 1) if mismatch else (0,)), "client failed to run"
    lines = result.stdout.strip().splitlines()
    assert len(lines) == 1
    output = json.loads(lines[0])
    if mismatch:
        assert not output["ok"] and not state["verified"]
        return
    assert output["ok"], state["error"] or "client rejected challenge"
    assert state["verified"], state["error"]
    assert output.get("settlement") is None
    assert not any("signature-sent" in key.lower() for key in output["responseHeaders"])


def test_python_session_open_reserve_commit_close():
    sponsor, receiver = Keypair(), Keypair()
    with serve(RpcFixture) as rpc:
        env = environment(PAY_KIT_HARNESS_PROTOCOL="session", MPP_HARNESS_RPC_URL=rpc,
                          MPP_HARNESS_NETWORK="devnet", MPP_HARNESS_PAY_TO=str(receiver.pubkey()),
                          MPP_HARNESS_AMOUNT="700", MPP_HARNESS_FEE_PAYER_SECRET_KEY=json.dumps(list(bytes(sponsor))))
        server = subprocess.Popen([sys.executable, "-u", str(ROOT / "harness/python-server/server.py")],
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            selector = selectors.DefaultSelector(); selector.register(server.stdout, selectors.EVENT_READ)
            assert selector.select(timeout=10), "server did not emit readiness"
            selector.close()
            ready = json.loads(server.stdout.readline())
            assert ready["capabilities"] == ["session"]
            env["MPP_HARNESS_TARGET_URL"] = f"http://127.0.0.1:{ready['port']}/session"
            result = subprocess.run([sys.executable, str(ROOT / "harness/python-session-client/main.py")], env=env,
                                    capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, "session client failed"
            output = json.loads(result.stdout)
            assert output["ok"] and output["responseBody"]["protocol"] == "session"
        finally:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=5)
            server.stdout.close(); server.stderr.close()
