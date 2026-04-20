"""Market buy via SnapTrade (Wealthsimple account must be linked in SnapTrade). Optional dep: pip install wsprobe[trade]."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional


def maybe_load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    for p in (
        Path.cwd() / ".env.secret",
        Path(__file__).resolve().parent.parent / ".env.secret",
    ):
        if p.is_file():
            load_dotenv(p, override=True)
            return


def _require_snaptrade_env() -> tuple[str, str, str, str]:
    maybe_load_dotenv()
    client_id = (os.environ.get("SNAPTRADE_CLIENT_ID") or "").strip()
    consumer_key = (
        os.environ.get("SNAPTRADE_CONSUMER_KEY") or os.environ.get("SNAPTRADE_API_KEY") or ""
    ).strip()
    user_id = (os.environ.get("SNAPTRADE_USER_ID") or "").strip()
    user_secret = (os.environ.get("SNAPTRADE_USER_SECRET") or "").strip()
    missing = [
        n
        for n, v in (
            ("SNAPTRADE_CLIENT_ID", client_id),
            ("SNAPTRADE_CONSUMER_KEY or SNAPTRADE_API_KEY", consumer_key),
            ("SNAPTRADE_USER_ID", user_id),
            ("SNAPTRADE_USER_SECRET", user_secret),
        )
        if not v
    ]
    if missing:
        raise RuntimeError(
            "Missing SnapTrade env: " + ", ".join(missing) + ". "
            "Set them (e.g. in .env.secret) after connecting Wealthsimple via the SnapTrade portal. "
            "See docs/README_SNAPTRADE.md."
        )
    return client_id, consumer_key, user_id, user_secret


def _first_account_id(snaptrade: Any, user_id: str, user_secret: str) -> str:
    r = snaptrade.account_information.list_user_accounts(
        user_id=user_id,
        user_secret=user_secret,
    )
    accounts = getattr(r, "body", r)
    if not isinstance(accounts, list):
        accounts = [accounts] if accounts else []
    if not accounts:
        raise RuntimeError(
            "No SnapTrade-linked accounts. Use a production SnapTrade key and connect Wealthsimple "
            "via the portal (see docs/README_SNAPTRADE.md)."
        )
    acc = accounts[0]
    aid = acc.get("id") if isinstance(acc, dict) else getattr(acc, "id", None)
    if not aid:
        raise RuntimeError("Could not read account id from SnapTrade response.")
    return str(aid)


def place_market_buy(
    symbol: str,
    units: float,
    *,
    account_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Place a market BUY via SnapTrade → connected brokerage (e.g. Wealthsimple).
    Uses SNAPTRADE_* environment variables.
    """
    if units <= 0:
        raise ValueError("units must be positive")
    sym = symbol.strip().upper()
    if not sym:
        raise ValueError("symbol is required")

    try:
        from snaptrade_client import SnapTrade
    except ImportError as e:
        raise ImportError(
            "SnapTrade SDK not installed. Run: pip install 'wsprobe[trade]'"
        ) from e

    client_id, consumer_key, user_id, user_secret = _require_snaptrade_env()
    acc = (account_id or os.environ.get("SNAPTRADE_ACCOUNT_ID") or "").strip() or None

    snaptrade = SnapTrade(client_id=client_id, consumer_key=consumer_key)
    if not acc:
        acc = _first_account_id(snaptrade, user_id, user_secret)

    order = snaptrade.trading.place_force_order(
        user_id=user_id,
        user_secret=user_secret,
        account_id=acc,
        action="BUY",
        order_type="Market",
        time_in_force="Day",
        symbol=sym,
        universal_symbol_id=None,
        units=float(units),
        notional_value=None,
        price=None,
        stop=None,
        trading_session="REGULAR",
    )
    body = getattr(order, "body", order)
    if isinstance(body, dict):
        return dict(body)
    if hasattr(body, "__dict__"):
        return {k: v for k, v in body.__dict__.items() if not k.startswith("_")}
    return {"raw": str(body)}


def format_order_result(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True)
