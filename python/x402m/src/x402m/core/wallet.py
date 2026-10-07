"""Owner-provisioned signing interface. Agent Auth keys are never wallets."""
from typing import Protocol


class SolanaSigner(Protocol):
    public_key: str
    async def sign_transaction(self, transaction: bytes) -> bytes:
        """Review recipient, mint, amount, fees and program under owner policy."""
        ...
