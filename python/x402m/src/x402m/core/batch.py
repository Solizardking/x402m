"""SVM batch-settlement wire validation and cryptography. No broadcasting.

Implements the supplied SVM scheme's binary contracts. A trusted network reader
must independently decode/validate the canonical onchain account and mint owner.
"""
import base64
import hashlib
import re
import struct
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from solders.pubkey import Pubkey
from ..types.config import MAINNET

PROGRAMS = {MAINNET: "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX"}
TOKEN_PROGRAMS = {"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
U64_MAX = (1 << 64) - 1


class SchemeError(ValueError):
    def __init__(self, reason):
        self.reason = reason if reason == "duplicate_settlement" else "invalid_batch_settlement_svm_" + reason
        super().__init__(self.reason)


def b58decode(value, length):
    if not isinstance(value, str) or not value or len(value) > 100:
        raise SchemeError("payload_type")
    number = 0
    try:
        for character in value:
            number = number * 58 + ALPHABET.index(character)
    except ValueError as error:
        raise SchemeError("payload_type") from error
    raw = b"\0" * (len(value) - len(value.lstrip("1"))) + number.to_bytes((number.bit_length() + 7) // 8, "big")
    if len(raw) != length:
        raise SchemeError("payload_type")
    return raw


def b58encode(raw):
    number = int.from_bytes(raw, "big")
    result = ""
    while number:
        number, remainder = divmod(number, 58)
        result = ALPHABET[remainder] + result
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + result


def amount(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value) or int(value) > U64_MAX:
        raise SchemeError("payload_type")
    return int(value)


def integer(value, maximum=U64_MAX):
    if type(value) is not int or not 0 <= value <= maximum:
        raise SchemeError("payload_type")
    return value


def address(value):
    return b58decode(value, 32)


def canonical_program(network):
    if network not in PROGRAMS:
        raise SchemeError("channel_state")  # Never infer a devnet deployment from mainnet.
    return PROGRAMS[network]


def validate_requirements(requirements):
    if requirements.get("scheme") != "batch-settlement":
        raise SchemeError("payload_type")
    canonical_program(requirements.get("network"))
    amount(requirements.get("amount"))
    address(requirements.get("asset")); address(requirements.get("payTo"))
    timeout = integer(requirements.get("maxTimeoutSeconds"), (1 << 31) - 1)
    if timeout == 0:
        raise SchemeError("payload_type")
    extra = requirements.get("extra")
    if not isinstance(extra, dict):
        raise SchemeError("payload_type")
    if "channelProgram" in extra or "assetTransferMethod" in extra:
        raise SchemeError("payload_type")
    if extra.get("paymentFlow", "authorization") != "authorization":
        raise SchemeError("payment_flow")
    for field in ("feePayer", "receiverAuthorizer"):
        address(extra.get(field))
    delay = integer(extra.get("withdrawDelay"))
    if not 900 <= delay <= 2592000 or delay < timeout:
        raise SchemeError("withdraw_delay_out_of_range")
    if extra.get("tokenProgram") not in TOKEN_PROGRAMS:
        raise SchemeError("token_program")
    mode = extra.get("voucherSigner", "client")
    if mode not in ("client", "server"):
        raise SchemeError("payload_type")
    if mode == "server":
        address(extra.get("operator"))
    elif "operator" in extra:
        raise SchemeError("payload_type")
    if "memo" in extra and (not isinstance(extra["memo"], str) or len(extra["memo"].encode()) > 256):
        raise SchemeError("payload_type")
    if "minDeposit" in extra and (amount(extra["minDeposit"]) == 0 or amount(extra["minDeposit"]) < amount(requirements["amount"])):
        raise SchemeError("payload_type")
    for field in ("recentSlot", "maxIdleSecs"):
        if field in extra:
            integer(extra[field])
            if field == "maxIdleSecs" and extra[field] == 0:
                raise SchemeError("payload_type")
    if "recentBlockhash" in extra:
        address(extra["recentBlockhash"])
    return mode


def validate_config(config, requirements):
    mode = validate_requirements(requirements)
    extra = requirements["extra"]
    for field in ("payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token"):
        address(config.get(field))
    if config["receiver"] != requirements["payTo"] or config["token"] != requirements["asset"]:
        raise SchemeError("channel_state")
    if config["receiverAuthorizer"] != extra["receiverAuthorizer"]:
        raise SchemeError("receiver_authorizer_mismatch")
    if integer(config.get("withdrawDelay")) != extra["withdrawDelay"]:
        raise SchemeError("withdraw_delay_mismatch")
    if config.get("voucherSigner", "client") != mode:
        raise SchemeError("payload_type")
    if mode == "server" and config["payerAuthorizer"] != extra["operator"]:
        raise SchemeError("voucher_signature")
    if extra["feePayer"] in (config["payer"], config["payerAuthorizer"]):
        raise SchemeError("fee_payer_mismatch")
    amount(config.get("salt")); integer(config.get("openSlot"))
    return mode


def derive_channel_id(config, requirements):
    validate_config(config, requirements)
    seeds = [b"channel", address(config["payer"]), address(requirements["extra"]["feePayer"]),
             address(config["token"]), address(config["payerAuthorizer"]),
             struct.pack("<Q", amount(config["salt"])), struct.pack("<Q", config["openSlot"])]
    key, _ = Pubkey.find_program_address(seeds, Pubkey.from_string(canonical_program(requirements["network"])))
    return str(key)


def voucher_message(channel_id, cumulative, expires_at=0):
    if expires_at != 0 or type(expires_at) is not int:
        raise SchemeError("voucher_expiry")
    return b"\x56\x01" + address(channel_id) + struct.pack("<Qq", amount(cumulative), expires_at)


def verify_signature(public_key, signature, message, reason):
    try:
        Ed25519PublicKey.from_public_bytes(address(public_key)).verify(b58decode(signature, 64), message)
    except (InvalidSignature, SchemeError, ValueError) as error:
        raise SchemeError(reason) from error


def verify_voucher(voucher, channel_id, authorizer):
    if voucher.get("channelId") != channel_id:
        raise SchemeError("channel_id_mismatch")
    verify_signature(authorizer, voucher.get("signature"), voucher_message(channel_id, voucher.get("maxClaimableAmount"), voucher.get("expiresAt")), "voucher_signature")
    return amount(voucher["maxClaimableAmount"])


def authorization_message(proof, operator):
    request_id = proof.get("requestId")
    if not isinstance(request_id, str) or not 1 <= len(request_id.encode()) <= 256 or proof.get("type") != "proof":
        raise SchemeError("payload_type")
    request = request_id.encode()
    return (b"x402-batch-authorization-v2" + address(proof.get("channelId")) + address(proof.get("payer"))
            + address(operator) + struct.pack("<H", len(request)) + request
            + struct.pack("<Qq", amount(proof.get("authorizedAmount")), integer(proof.get("expiresAt"), (1 << 63) - 1)))


def verify_authorization(proof, config, requirements, now, refund=False):
    channel_id = derive_channel_id(config, requirements)
    if proof.get("payer") != config["payer"] or proof.get("channelId") != channel_id:
        raise SchemeError("channel_id_mismatch")
    if amount(proof.get("authorizedAmount")) != (0 if refund else amount(requirements["amount"])):
        raise SchemeError("cumulative_amount_mismatch")
    if integer(proof.get("expiresAt"), (1 << 63) - 1) <= now:
        raise SchemeError("payload_type")
    verify_signature(config["payer"], proof.get("signature"), authorization_message(proof, requirements["extra"]["operator"]), "voucher_signature")


def close_authorization_digest(network, fee_payer, channel_id, cumulative, valid_before, voucher_expires_at=0):
    network_bytes = network.encode()
    if len(network_bytes) > 65535:
        raise SchemeError("close_authorization")
    voucher_message(channel_id, cumulative, voucher_expires_at)
    message = (b"x402:batch-settlement:svm:close:v1\0" + struct.pack("<H", len(network_bytes)) + network_bytes
               + address(canonical_program(network)) + address(fee_payer) + address(channel_id)
               + struct.pack("<Qqq", amount(cumulative), voucher_expires_at, integer(valid_before, (1 << 63) - 1)))
    return hashlib.sha256(message).digest()


def verify_close_authorization(close, requirements, channel_id, cumulative, bound_receiver_authorizer, now):
    if bound_receiver_authorizer != requirements["extra"]["receiverAuthorizer"]:
        raise SchemeError("receiver_authorizer_mismatch")
    before = integer(close.get("validBefore"), (1 << 63) - 1)
    if not now < before <= now + requirements["maxTimeoutSeconds"]:
        raise SchemeError("close_authorization")
    digest = close_authorization_digest(requirements["network"], requirements["extra"]["feePayer"], channel_id, cumulative, before)
    verify_signature(bound_receiver_authorizer, close.get("signature"), digest, "close_authorization")


def deposit_target(requirements, local_maximum, operator_grants=None):
    """Client policy: 402 data cannot grant operator trust or increase local cap."""
    mode = validate_requirements(requirements)
    cap = amount(local_maximum)
    if mode == "server":
        grant = (operator_grants or {}).get(requirements["extra"]["operator"], {})
        if requirements["asset"] not in grant:
            raise SchemeError("channel_state")
        cap = min(cap, amount(grant[requirements["asset"]]))
    price = amount(requirements["amount"])
    if cap < price or cap == 0:
        raise SchemeError("cumulative_exceeds_deposit")
    return str(min(cap, max(price, amount(requirements["extra"].get("minDeposit", requirements["amount"])))))


@dataclass(frozen=True)
class ChannelSnapshot:
    """Trusted reader output, after owner/codec/version/PDA/mint verification.

    Not constructed from message content or corrective challenge state.
    """
    channel_id: str
    deposit: int
    settled: int
    status: str
    token_program: str


def validate_client_payload(payment, requirements, snapshot, now):
    if type(payment.get("x402Version")) is not int or payment["x402Version"] != 2 or payment.get("accepted") != requirements:
        raise SchemeError("payload_type")
    payload = payment.get("payload")
    if not isinstance(payload, dict) or payload.get("type") not in ("deposit", "voucher", "authorization", "refund"):
        raise SchemeError("payload_type")
    config = payload.get("channelConfig")
    if not isinstance(config, dict):
        raise SchemeError("payload_type")
    mode = validate_config(config, requirements)
    channel_id = derive_channel_id(config, requirements)
    if snapshot.channel_id != channel_id or not 0 <= snapshot.settled <= snapshot.deposit <= U64_MAX:
        raise SchemeError("channel_state")
    if snapshot.token_program != requirements["extra"]["tokenProgram"]:
        raise SchemeError("token_program")
    kind = payload["type"]
    if kind != "refund" and snapshot.status != "Open":
        raise SchemeError("channel_closing")
    if kind == "refund" and snapshot.status not in ("Open", "Closing"):
        raise SchemeError("close_state")
    if kind == "refund" and "amount" in payload:
        raise SchemeError("close_amount_unsupported")
    if kind == "voucher" and mode != "client" or kind == "authorization" and mode != "server":
        raise SchemeError("payload_type")
    cumulative = None
    if mode == "client":
        if "authorization" in payload or not isinstance(payload.get("voucher"), dict):
            raise SchemeError("payload_type")
        cumulative = verify_voucher(payload["voucher"], channel_id, config["payerAuthorizer"])
    else:
        if "voucher" in payload or not isinstance(payload.get("authorization"), dict):
            raise SchemeError("payload_type")
        verify_authorization(payload["authorization"], config, requirements, now, kind == "refund")
    ceiling = snapshot.deposit
    if kind == "deposit":
        deposit = payload.get("deposit", {})
        delta = amount(deposit.get("amount"))
        if delta == 0:
            raise SchemeError("payload_type")
        try:
            transaction = base64.b64decode(deposit.get("transaction", ""), validate=True)
        except (ValueError, TypeError) as error:
            raise SchemeError("setup_transaction") from error
        if not transaction or len(transaction) > 1232:
            raise SchemeError("setup_transaction")
        ceiling += delta
        if ceiling > U64_MAX:
            raise SchemeError("cumulative_exceeds_deposit")
    if cumulative is not None:
        if cumulative > ceiling:
            raise SchemeError("cumulative_exceeds_deposit")
        if kind != "refund" and (cumulative <= snapshot.settled or cumulative < snapshot.settled + amount(requirements["amount"])):
            raise SchemeError("cumulative_amount_mismatch")
        if kind == "refund" and cumulative < snapshot.settled:
            raise SchemeError("close_state")
    return channel_id, cumulative


def discovery_filters(role, public_key):
    address(public_key)
    if role not in ("payer", "feePayer"):
        raise ValueError("role must be payer or feePayer")
    return {"encoding": "base64", "commitment": "confirmed", "filters": [
        {"dataSize": 256}, {"memcmp": {"offset": 88 if role == "payer" else 216, "bytes": public_key}}]}
