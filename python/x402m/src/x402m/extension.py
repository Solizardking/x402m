# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# Modified by Musebook on 2026-10-07: local experimental URI and exact activation.
"""Extension declaration and constants for A2A x402 protocol."""

from .types.config import X402_EXTENSION_URI


def get_extension_declaration(
    description: str = "Supports experimental Musebook Solana x402m payment composition", required: bool = True
) -> dict:
    """Creates extension declaration for AgentCard."""
    return {"uri": X402_EXTENSION_URI, "description": description, "required": required}


def check_extension_activation(request_headers: dict) -> bool:
    """Check if x402 extension is activated via HTTP headers."""
    extensions = next((value for key, value in request_headers.items() if key.lower() == "x-a2a-extensions"), "")
    return X402_EXTENSION_URI in [item.strip() for item in extensions.split(",")]


def add_extension_activation_header(response_headers: dict) -> dict:
    """Echo extension URI in response header to confirm activation."""
    existing = next((key for key in response_headers if key.lower() == "x-a2a-extensions"), "X-A2A-Extensions")
    values = [item.strip() for item in response_headers.get(existing, "").split(",") if item.strip()]
    if X402_EXTENSION_URI not in values:
        values.append(X402_EXTENSION_URI)
    response_headers[existing] = ", ".join(values)
    return response_headers
