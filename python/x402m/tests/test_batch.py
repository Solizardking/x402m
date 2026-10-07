import copy
import json
import struct
from concurrent.futures import ThreadPoolExecutor

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from x402m import ChannelStore, ChannelSnapshot, SchemeError
from x402m.core.batch import (
    MAINNET, PROGRAMS, TOKEN_PROGRAMS, b58encode, b58decode, amount, voucher_message,
    derive_channel_id, verify_voucher, authorization_message, verify_authorization,
    close_authorization_digest, verify_close_authorization, deposit_target,
    validate_client_payload, validate_requirements, discovery_filters,
)
from x402m.executors.server import execute_paid_request


@pytest.fixture
def channel():
    keys = [Ed25519PrivateKey.from_private_bytes(bytes([i]) * 32) for i in range(1, 6)]
    payer, operator, receiver, authorizer, sponsor = [b58encode(key.public_key().public_bytes_raw()) for key in keys]
    requirements = {"scheme": "batch-settlement", "network": MAINNET, "amount": "1000",
                    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "payTo": receiver,
                    "maxTimeoutSeconds": 300, "extra": {"feePayer": sponsor, "receiverAuthorizer": authorizer,
                    "withdrawDelay": 3600, "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}}
    config = {"payer": payer, "payerAuthorizer": payer, "receiver": receiver,
              "receiverAuthorizer": authorizer, "token": requirements["asset"], "withdrawDelay": 3600,
              "salt": "42", "openSlot": 341000000}
    return keys, requirements, config


def voucher(key, channel_id, cumulative):
    return {"channelId": channel_id, "maxClaimableAmount": str(cumulative), "expiresAt": 0,
            "signature": b58encode(key.sign(voucher_message(channel_id, str(cumulative))))}


def snapshot(channel_id, requirements, deposit=10000, settled=0, status="Open"):
    return ChannelSnapshot(channel_id, deposit, settled, status, requirements["extra"]["tokenProgram"])


def server_mode(channel):
    keys, requirements, config = channel
    operator = b58encode(keys[1].public_key().public_bytes_raw())
    requirements["extra"].update(voucherSigner="server", operator=operator)
    config.update(voucherSigner="server", payerAuthorizer=operator)
    return keys, requirements, config


def proof(key, config, requirements, request_id="req-1", ceiling="1000", expiry=1200):
    value = {"type": "proof", "channelId": derive_channel_id(config, requirements), "payer": config["payer"],
             "requestId": request_id, "authorizedAmount": ceiling, "expiresAt": expiry}
    value["signature"] = b58encode(key.sign(authorization_message(value, requirements["extra"]["operator"])))
    return value


def test_binary_voucher_contract_and_binding(channel):
    keys, req, config = channel
    cid = derive_channel_id(config, req)
    message = voucher_message(cid, "18446744073709551615")
    assert message == bytes.fromhex("5601") + b58decode(cid, 32) + struct.pack("<Qq", (1 << 64) - 1, 0)
    assert len(message) == 50
    value = voucher(keys[0], cid, 1000)
    assert verify_voucher(value, cid, config["payerAuthorizer"]) == 1000
    value["maxClaimableAmount"] = "2000"
    with pytest.raises(SchemeError, match="voucher_signature"):
        verify_voucher(value, cid, config["payerAuthorizer"])
    with pytest.raises(SchemeError, match="voucher_expiry"):
        voucher_message(cid, "1000", 1)
    modified = dict(config, openSlot=config["openSlot"] + 1)
    assert derive_channel_id(modified, req) != cid


@pytest.mark.parametrize("bad", ["-1", "1.0", "01", "18446744073709551616", 1000, True, "1e3", ""])
def test_amount_rejections(bad):
    with pytest.raises(SchemeError):
        amount(bad)


@pytest.mark.parametrize("changes,reason", [
    ({"withdrawDelay": 899}, "withdraw_delay_out_of_range"),
    ({"withdrawDelay": 2592001}, "withdraw_delay_out_of_range"),
    ({"paymentFlow": "upfront"}, "payment_flow"),
    ({"channelProgram": PROGRAMS[MAINNET]}, "payload_type"),
    ({"tokenProgram": "evil"}, "token_program"),
    ({"operator": "1" * 32}, "payload_type"),
])
def test_requirement_rejections(channel, changes, reason):
    _, req, _ = channel
    req["extra"].update(changes)
    with pytest.raises(SchemeError, match=reason):
        validate_requirements(req)


def test_server_proof_domains_and_policy(channel):
    keys, req, config = server_mode(channel)
    value = proof(keys[0], config, req, request_id="雪")
    message = authorization_message(value, req["extra"]["operator"])
    assert message.startswith(b"x402-batch-authorization-v2")
    assert b"\x03\x00" + "雪".encode() in message
    verify_authorization(value, config, req, now=1000)
    with pytest.raises(SchemeError):
        verify_authorization(value, config, req, now=1200)
    altered = dict(value, requestId="different")
    with pytest.raises(SchemeError, match="voucher_signature"):
        verify_authorization(altered, config, req, now=1000)
    with pytest.raises(SchemeError):
        deposit_target(req, "10000")
    req["extra"]["minDeposit"] = "1000000"
    grants = {req["extra"]["operator"]: {req["asset"]: "2000"}}
    assert deposit_target(req, "10000", grants) == "2000"


def test_close_domain_and_bound_authorizer(channel):
    keys, req, config = channel
    cid = derive_channel_id(config, req)
    digest = close_authorization_digest(MAINNET, req["extra"]["feePayer"], cid, "1000", 1200)
    close = {"validBefore": 1200, "signature": b58encode(keys[3].sign(digest))}
    verify_close_authorization(close, req, cid, "1000", config["receiverAuthorizer"], 1000)
    with pytest.raises(SchemeError, match="close_authorization"):
        verify_close_authorization(close, req, cid, "2000", config["receiverAuthorizer"], 1000)
    with pytest.raises(SchemeError, match="close_authorization"):
        verify_close_authorization(close, req, cid, "1000", config["receiverAuthorizer"], 1200)
    with pytest.raises(SchemeError, match="receiver_authorizer_mismatch"):
        verify_close_authorization(close, req, cid, "1000", config["payer"], 1000)


def test_payload_limits_and_closing(channel):
    keys, req, config = channel
    cid = derive_channel_id(config, req)
    payment = {"x402Version": 2, "accepted": req, "payload": {"type": "voucher", "channelConfig": config, "voucher": voucher(keys[0], cid, 1000)}}
    assert validate_client_payload(payment, req, snapshot(cid, req), 1000) == (cid, 1000)
    with pytest.raises(SchemeError, match="channel_closing"):
        validate_client_payload(payment, req, snapshot(cid, req, status="Closing"), 1000)
    with pytest.raises(SchemeError, match="cumulative_exceeds_deposit"):
        validate_client_payload(payment, req, snapshot(cid, req, deposit=500), 1000)
    req["amount"] = "0"
    payment["payload"]["voucher"] = voucher(keys[0], cid, 0)
    with pytest.raises(SchemeError, match="cumulative_amount_mismatch"):
        validate_client_payload(payment, req, snapshot(cid, req), 1000)


async def test_paid_client_success_failure_replay_and_restart(channel, tmp_path):
    keys, req, config = channel
    cid = derive_channel_id(config, req)
    path = tmp_path / "state.sqlite"
    store = ChannelStore(path)
    payment = {"x402Version": 2, "accepted": req, "payload": {"type": "voucher", "channelConfig": config, "voucher": voucher(keys[0], cid, 1000)}}
    calls = []
    async def handler():
        calls.append(1)
        return "resource", "1000"
    body, response = await execute_paid_request(payment, req, snapshot(cid, req), store, handler, 1000)
    assert body == "resource" and response["transaction"] == ""
    assert response["extra"]["chargedAmount"] == "1000"
    store.close()
    store = ChannelStore(path)
    with pytest.raises(SchemeError, match="duplicate_settlement"):
        await execute_paid_request(payment, req, snapshot(cid, req), store, handler, 1000)
    assert len(calls) == 1 and store.state(cid)["charged"] == "1000"
    payment["payload"]["voucher"] = voucher(keys[0], cid, 2000)
    async def failed():
        raise RuntimeError("failed resource")
    with pytest.raises(RuntimeError):
        await execute_paid_request(payment, req, snapshot(cid, req), store, failed, 1000)
    assert store.state(cid)["charged"] == "1000"
    store.mark_closing(cid)
    store.close()


def test_server_capacity_completion_and_durable_binding(channel, tmp_path):
    keys, req, config = server_mode(channel)
    cid = derive_channel_id(config, req)
    path = tmp_path / "state.sqlite"
    store = ChannelStore(path)
    store.register(cid, config, req, snapshot(cid, req, deposit=2000))
    store.bind_receiver(MAINNET, cid, config["receiverAuthorizer"], "owner")
    with pytest.raises(SchemeError, match="delegated_unauthenticated"):
        store.bind_receiver(MAINNET, cid, config["receiverAuthorizer"], "other")
    with pytest.raises(SchemeError, match="receiver_authorizer_mismatch"):
        store.bind_receiver(MAINNET, cid, config["payer"], "owner")
    store.reserve(cid, "a", "1000", "server")
    store.reserve(cid, "b", "1000", "server")
    with pytest.raises(SchemeError, match="cumulative_exceeds_deposit"):
        store.reserve(cid, "c", "1", "server")
    with pytest.raises(SchemeError, match="close_state"):
        store.mark_closing(cid)
    sign = lambda channel_id, cumulative: voucher(keys[1], channel_id, cumulative)
    second = store.complete(cid, "b", "400", signer=sign)
    first = store.complete(cid, "a", "800", signer=sign)
    assert second["extra"]["voucher"]["maxClaimableAmount"] == "400"
    assert first["extra"]["voucher"]["maxClaimableAmount"] == "1200"
    with pytest.raises(SchemeError, match="duplicate_settlement"):
        store.reserve(cid, "b", "1000", "server")
    store.close()
    store = ChannelStore(path)
    assert store.receiver_binding(MAINNET, cid)["caller"] == "owner"
    assert store.state(cid)["charged"] == "1200"
    store.close()


def test_parallel_connections_reserve_capacity_atomically(channel, tmp_path):
    _, req, config = server_mode(channel)
    cid = derive_channel_id(config, req)
    path = tmp_path / "state.sqlite"
    store = ChannelStore(path)
    store.register(cid, config, req, snapshot(cid, req, deposit=1000))
    store.close()
    def reserve(index):
        connection = ChannelStore(path)
        try:
            connection.reserve(cid, str(index), "1000", "server")
            return True
        except SchemeError:
            return False
        finally:
            connection.close()
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(reserve, range(4))) == 1


async def test_server_handler_and_commit_failure_no_reexecution(channel, tmp_path):
    keys, req, config = server_mode(channel)
    cid = derive_channel_id(config, req)
    store = ChannelStore(tmp_path / "state.sqlite")
    payment = {"x402Version": 2, "accepted": req, "payload": {"type": "authorization", "channelConfig": config, "authorization": proof(keys[0], config, req)}}
    calls = []
    async def handler():
        calls.append(1)
        return "resource", "500"
    with pytest.raises(SchemeError, match="voucher_signature"):
        await execute_paid_request(payment, req, snapshot(cid, req), store, handler, 1000)
    with pytest.raises(SchemeError, match="duplicate_settlement"):
        await execute_paid_request(payment, req, snapshot(cid, req), store, handler, 1000, operator_signer=lambda c, a: voucher(keys[1], c, a))
    assert len(calls) == 1 and store.state(cid)["charged"] == "0"
    store.close()


def test_discovery_offsets(channel):
    _, req, config = channel
    assert discovery_filters("payer", config["payer"])["filters"][1]["memcmp"]["offset"] == 88
    assert discovery_filters("feePayer", req["extra"]["feePayer"])["filters"][1]["memcmp"]["offset"] == 216
