import base64
import hashlib
import json
import os

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from x402m import X402mClient
from x402m.core.client import encode
from x402m.extension import check_extension_activation, add_extension_activation_header
from x402m.types.config import X402_EXTENSION_URI, MAINNET
from x402m.core.protocol import settle_payment, confirmed_settlement


def decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


async def test_jwt_exact_body_signature_fresh_nonce_and_enrollment():
    key = Ed25519PrivateKey.generate()
    attempts = []
    def respond(request):
        token = request.headers["authorization"].split()[1]
        header, claims, signature = token.split(".")
        key.public_key().verify(decode(signature), (header + "." + claims).encode())
        assert json.loads(decode(header)) == {"alg": "EdDSA", "typ": "agent+jwt"}
        value = json.loads(decode(claims))
        assert value["ath"] == encode(hashlib.sha256(request.content).digest())
        assert value["aud"] == value["htu"] == str(request.url)
        assert value["exp"] - value["iat"] == 60
        assert value["capabilities"] == ["x402m.send"] and value["htm"] == "POST"
        attempts.append(value["jti"])
        return httpx.Response(200, json={"data": {"state": "accepted"}})
    async with X402mClient("agent", key, transport=httpx.MockTransport(respond)) as client:
        for _ in range(2):
            assert await client.execute("x402m.send", {"to": "@peer", "requestId": "same", "kind": "request", "content": "雪"}) == {"state": "accepted"}
    assert len(set(attempts)) == 2
    async with X402mClient() as client:
        with pytest.raises(ValueError, match="enrollment"):
            await client.execute("x402m.inbox")


@pytest.mark.parametrize("origin", ["http://evil.example", "https://user:password@example.com", "https://example.com/path", "https://example.com?query=1", "ftp://localhost"])
def test_provider_rejections(origin):
    with pytest.raises(ValueError):
        X402mClient(provider=origin)


async def test_discovery_and_redirect_refusal():
    def respond(request):
        return httpx.Response(200, json={"path": request.url.path})
    async with X402mClient(transport=httpx.MockTransport(respond)) as client:
        result = await client.discover()
        assert result["protocol"]["path"] == "/api/x402m/discovery"
    async with X402mClient(transport=httpx.MockTransport(lambda _: httpx.Response(302, headers={"location": "https://evil.example"}))) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await client.read("/api/x402m/discovery")


async def test_private_jwk_permissions_and_public_binding(tmp_path):
    key = Ed25519PrivateKey.generate()
    path = tmp_path / "agent.private.jwk"
    jwk = {"kty": "OKP", "crv": "Ed25519", "d": encode(key.private_bytes_raw()), "x": encode(key.public_key().public_bytes_raw())}
    path.write_text(json.dumps(jwk)); path.chmod(0o600)
    async with X402mClient.from_env({"X402M_KEY_FILE": str(path), "X402M_AGENT_ID": "agent"}) as client:
        assert client.agent_id == "agent"
    path.chmod(0o644)
    with pytest.raises(ValueError, match="private"):
        X402mClient.from_env({"X402M_KEY_FILE": str(path)})
    path.chmod(0o600); jwk["x"] = encode(bytes(32)); path.write_text(json.dumps(jwk))
    with pytest.raises(ValueError, match="mismatch"):
        X402mClient.from_env({"X402M_KEY_FILE": str(path)})


def test_extension_activation_exact_tokens():
    assert check_extension_activation({"x-a2a-extensions": "other, " + X402_EXTENSION_URI})
    assert not check_extension_activation({"X-A2A-Extensions": X402_EXTENSION_URI + "-fake"})
    assert add_extension_activation_header({"x-a2a-extensions": "other"})["x-a2a-extensions"] == "other, " + X402_EXTENSION_URI


async def test_payment_boundary_no_implicit_spend_or_pending_unlock():
    calls = []
    class Fixture:
        async def verify(self, payload, requirements):
            return {"isValid": True}
        async def settle(self, payload, requirements):
            calls.append(1)
            return {"success": True, "pending": True, "transaction": "signature", "network": MAINNET}
    req = {"amount": "1000"}; payload = {"accepted": req}
    with pytest.raises(ValueError, match="owner"):
        await settle_payment(payload, req, Fixture())
    response = await settle_payment(payload, req, Fixture(), owner_approved=True)
    assert not confirmed_settlement(response, MAINNET)
    assert len(calls) == 1
