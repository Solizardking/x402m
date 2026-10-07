"""Steady-state offchain paid handler. Deposit and refund use separate adapters."""
from ..core.batch import validate_client_payload, amount, SchemeError, validate_requirements


async def execute_paid_request(payment, requirements, snapshot, store, handler, now, *, operator_signer=None):
    channel_id, cumulative = validate_client_payload(payment, requirements, snapshot, now)
    payload = payment["payload"]
    if payload["type"] not in ("voucher", "authorization"):
        raise SchemeError("payload_type")  # Refund must never execute the resource.
    mode = validate_requirements(requirements)
    request_id = payload["authorization"]["requestId"] if mode == "server" else f"voucher:{cumulative}"
    store.register(channel_id, payload["channelConfig"], requirements, snapshot)
    store.reserve(channel_id, request_id, requirements["amount"], mode, payload.get("voucher"))
    try:
        result, metered_amount = await handler()
    except BaseException:
        store.fail(channel_id, request_id)
        raise
    # A commit/signing failure leaves the operation reserved for reconciliation;
    # re-running the handler after an ambiguous success would duplicate work.
    actual = requirements["amount"] if mode == "client" else metered_amount
    amount(actual)
    response = store.complete(channel_id, request_id, actual, payload.get("voucher"), operator_signer)
    response["extra"]["channelState"]["totalClaimed"] = str(snapshot.settled)
    response["payer"] = payload["channelConfig"]["payer"]
    return result, response
