"""Agent Auth transport matching x402m-bot/client.mjs; no wallet signing."""
import base64
import hashlib
import json
import os
import stat
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from ..types.config import PROVIDER, CAPABILITIES


def encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def compact(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


class X402mClient:
    def __init__(self, agent_id=None, private_key=None, provider=PROVIDER, transport=None):
        url = urlsplit(provider)
        if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1"))):
            raise ValueError("HTTPS required")
        if not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError("provider must be an origin")
        self.provider = provider.rstrip("/")
        self.agent_id, self.key = agent_id, private_key
        self.http = httpx.AsyncClient(transport=transport, timeout=30, follow_redirects=False)

    @classmethod
    def from_env(cls, env=None, **kwargs):
        env = os.environ if env is None else env
        key = None
        if env.get("X402M_KEY_FILE"):
            with Path(env["X402M_KEY_FILE"]).open("rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                    raise ValueError("X402M_KEY_FILE must be private (chmod 600)")
                jwk = json.load(handle)
            if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519" or not jwk.get("d"):
                raise ValueError("Expected private Ed25519 agent JWK, not a wallet key")
            raw = base64.urlsafe_b64decode(jwk["d"] + "=" * (-len(jwk["d"]) % 4))
            key = Ed25519PrivateKey.from_private_bytes(raw)
            if jwk.get("x") != encode(key.public_key().public_bytes_raw()):
                raise ValueError("Ed25519 public/private JWK mismatch")
        return cls(env.get("X402M_AGENT_ID"), key, env.get("X402M_PROVIDER", PROVIDER), **kwargs)

    async def read(self, path):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("origin-relative path required")
        response = await self.http.get(self.provider + path)
        response.raise_for_status()
        return response.json()

    async def discover(self):
        return {"protocol": await self.read("/api/x402m/discovery"), "directory": await self.read("/api/x402m/agents")}

    async def execute(self, capability, arguments=None):
        if capability not in CAPABILITIES:
            raise ValueError("Unknown messaging capability")
        if not self.agent_id or not self.key:
            raise ValueError("Agent enrollment required; set X402M_AGENT_ID and X402M_KEY_FILE")
        url = self.provider + "/api/auth/capability/execute"
        body = compact({"capability": capability, "arguments": {} if arguments is None else arguments})
        now = int(time.time())
        claims = {"sub": self.agent_id, "aud": url, "iat": now, "exp": now + 60,
                  "jti": str(uuid.uuid4()), "capabilities": [capability], "htm": "POST", "htu": url,
                  "ath": encode(hashlib.sha256(body).digest())}
        unsigned = encode(compact({"alg": "EdDSA", "typ": "agent+jwt"})) + "." + encode(compact(claims))
        token = unsigned + "." + encode(self.key.sign(unsigned.encode()))
        response = await self.http.post(url, content=body, headers={"content-type": "application/json", "authorization": "Bearer " + token})
        response.raise_for_status()
        result = response.json()
        return result.get("data", result)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.http.aclose()
