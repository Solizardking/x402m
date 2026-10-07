"""Offline client-mode channel fixture: no RPC, wallet funding or real service."""
import asyncio
import tempfile
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from x402m import ChannelStore, ChannelSnapshot
from x402m.core.batch import b58encode, derive_channel_id, voucher_message
from x402m.types.config import MAINNET, USDC
from x402m.executors.server import execute_paid_request

async def main():
    # Ephemeral fixture keys only. Owner-controlled wallets remain external.
    keys = [Ed25519PrivateKey.generate() for _ in range(4)]
    payer, receiver, authorizer, sponsor = [b58encode(key.public_key().public_bytes_raw()) for key in keys]
    req = {"scheme": "batch-settlement", "network": MAINNET, "asset": USDC[MAINNET],
           "amount": "1000", "payTo": receiver, "maxTimeoutSeconds": 300,
           "extra": {"feePayer": sponsor, "receiverAuthorizer": authorizer, "withdrawDelay": 3600,
                     "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}}
    config = {"payer": payer, "payerAuthorizer": payer, "receiver": receiver,
              "receiverAuthorizer": authorizer, "token": req["asset"], "withdrawDelay": 3600,
              "salt": "42", "openSlot": 341000000}
    cid = derive_channel_id(config, req)
    signed = {"channelId": cid, "maxClaimableAmount": "1000", "expiresAt": 0,
              "signature": b58encode(keys[0].sign(voucher_message(cid, "1000")))}
    payment = {"x402Version": 2, "accepted": req, "payload": {"type": "voucher", "channelConfig": config, "voucher": signed}}
    fixture = ChannelSnapshot(cid, 10000, 0, "Open", req["extra"]["tokenProgram"])
    async def handler():
        return "offline fixture result", "1000"
    with tempfile.TemporaryDirectory(prefix="x402m-channel-demo-") as directory:
        store = ChannelStore(Path(directory) / "channels.sqlite")
        store.register(cid, config, req, fixture, initialize=True)
        try:
            result, receipt = await execute_paid_request(payment, req, fixture, store, handler, 1000)
            print(result)
            print("Offchain fixture commitment:", receipt["extra"]["commitmentId"])
            print("No deposit, onchain transaction or payout performed.")
        finally:
            store.close()

if __name__ == "__main__":
    asyncio.run(main())
