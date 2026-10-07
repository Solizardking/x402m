"""Resolve the user-supplied Pay Kit SDK without assuming the outer git root."""
import os
import sys
from pathlib import Path


def configure_pay_kit():
    source = Path(os.environ.get("PAY_KIT_SOURCE_DIR", Path(__file__).resolve().parents[1] / "pay-kit-main")).resolve()
    package = source / "python" / "src"
    if not (package / "solana_pay_kit" / "__init__.py").is_file():
        raise RuntimeError("PAY_KIT_SOURCE_DIR must point to the supplied pay-kit-main checkout")
    sys.path.insert(0, str(package))
    return source
