"""Credential-free public GETs; no enrollment, messages, inference or spending."""
import asyncio
import json
from x402m import X402mClient

async def main():
    async with X402mClient() as client:
        print(json.dumps(await client.discover(), indent=2))

if __name__ == "__main__":
    asyncio.run(main())
