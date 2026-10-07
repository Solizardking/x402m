"""Explicit facilitator boundary; importing this package never settles funds."""
from typing import Protocol


class Facilitator(Protocol):
    async def verify(self, payload: dict, requirements: dict) -> dict: ...
    async def settle(self, payload: dict, requirements: dict) -> dict: ...


async def verify_payment(payload, requirements, facilitator):
    if payload.get("accepted") != requirements:
        raise ValueError("Payload must match stored payment requirements")
    return await facilitator.verify(payload, requirements)


async def settle_payment(payload, requirements, facilitator, *, owner_approved=False):
    if owner_approved is not True:
        raise ValueError("Explicit owner payment policy required")
    verification = await verify_payment(payload, requirements, facilitator)
    if verification.get("isValid") is not True:
        raise ValueError("Payment verification failed")
    return await facilitator.settle(payload, requirements)


def confirmed_settlement(response, network):
    """Receipt shape guard only; independent RPC confirmation is still required."""
    return (response.get("success") is True and response.get("network") == network
            and bool(response.get("transaction")) and response.get("pending") is not True
            and not response.get("errorReason"))
