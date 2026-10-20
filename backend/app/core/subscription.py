"""Dashboard subscription: one expiry moment, enforced on the server.

A single row in Postgres (`app_subscription`) holds the moment access ends. This
FastAPI backend and the Node bitrix-sync API both read it, so one UPDATE changes
both and no restart is needed (see bitrix-sync/scripts/set_subscription.js).

  - No row            -> no limit: nothing is locked and the dashboard shows no countdown.
  - expires_at ahead  -> the dashboard shows a countdown.
  - expires_at passed -> every /api/* request answers 402 `subscription_expired`
                         (the page data, the Bitrix "to'lov" webhook, the Bitrix
                         iframe app — all of it) and the frontend shows the
                         "Subscription Expired" page. Only GET /api/subscription
                         stays open, so the page can explain what happened.

The decision is made here with the server's clock, never the browser's, so
changing the computer's date does not get around it. Bitrix / Meta webhooks under
/webhook/ are not /api/ and keep running (served by the Node service): leads are
still received and distributed, and nothing is lost while access is suspended.

The pure functions below import only the standard library; FastAPI / SQLAlchemy
are imported inside the functions that need them.
"""
import time
from datetime import datetime, timezone
from typing import Optional

BRAND = "Mountain"
SUPPORT_DEFAULT = "@Jahongir_data365"
CACHE_TTL_SEC = 10  # how long a DB read is reused

_cache: dict = {"at": float("-inf"), "row": None}


def build_status(row: Optional[tuple], now: datetime) -> dict:
    """Public status for a DB row `(expires_at, support_contact)` or None."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    base = {"brand": BRAND, "server_time": now.astimezone(timezone.utc).isoformat()}
    if row is None or row[0] is None:
        return {**base, "enabled": False, "expired": False}

    expires_at, support = row
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    support = (support or SUPPORT_DEFAULT).strip() or SUPPORT_DEFAULT
    seconds_left = int((expires_at - now).total_seconds())
    return {
        **base,
        "enabled": True,
        "expired": seconds_left <= 0,
        "expires_at": expires_at.astimezone(timezone.utc).isoformat(),
        "seconds_left": max(seconds_left, 0),
        "support": support,
        "support_url": "https://t.me/" + support.lstrip("@"),
    }


def expired_payload(status: dict) -> dict:
    """Body of the 402 answer every blocked API request gets."""
    return {
        "code": "subscription_expired",
        "detail": "subscription_expired",
        "message": f"{BRAND} dashboard subscription has expired. Contact support: {status['support']}",
        "support": status["support"],
        "support_url": status["support_url"],
        "expired_at": status["expires_at"],
    }


def _read_row() -> Optional[tuple]:
    from sqlalchemy import text
    from app.db_bx import bx_engine

    if bx_engine is None:
        return None
    with bx_engine.connect() as conn:
        r = conn.execute(text("SELECT expires_at, support_contact FROM app_subscription WHERE id = 1")).fetchone()
    return (r[0], r[1]) if r else None


def get_status(now: Optional[datetime] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    t = time.monotonic()
    if t - _cache["at"] > CACHE_TTL_SEC:
        try:
            _cache["row"] = _read_row()
        except Exception:
            # Table not created yet or a DB blip: keep the last known value, so a
            # lock that is already in force is not lifted by a failed read.
            pass
        _cache["at"] = t
    return build_status(_cache["row"], now)


def ensure_table() -> None:
    from sqlalchemy import text
    from app.db_bx import bx_engine

    if bx_engine is None:
        return
    with bx_engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_subscription (
                id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                expires_at      TIMESTAMPTZ NOT NULL,
                support_contact TEXT,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))


_BITRIX_IFRAME_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>{brand} Dashboard</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#0b1020;color:#e8ecf8;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">
<div><h2 style="margin:0 0 8px">Subscription Expired</h2>
<p style="margin:0 0 16px;opacity:.75">{brand} dashboard access is suspended.</p>
<a href="{url}" target="_blank" rel="noopener" style="color:#8ea2ff">Contact Support {support}</a></div></body></html>"""


def install_subscription_middleware(app) -> None:
    """Add the expiry guard to a FastAPI app. Install it AFTER the auth middleware:
    Starlette runs the last-added middleware first, and a locked dashboard must
    answer 402 (not 401) even to a client that is not logged in."""
    from fastapi import APIRouter
    from fastapi.responses import HTMLResponse, JSONResponse
    from starlette.concurrency import run_in_threadpool

    router = APIRouter()

    @router.get("/api/subscription")
    async def subscription_status():
        status = await run_in_threadpool(get_status)
        return JSONResponse(status, headers={"Cache-Control": "no-store"})

    app.include_router(router)

    @app.middleware("http")
    async def _subscription_mw(request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path == "/api/subscription":
            return await call_next(request)
        status = await run_in_threadpool(get_status)
        if not status["expired"]:
            return await call_next(request)
        if path.startswith("/api/bitrix/"):  # opened inside a Bitrix card: show a page, not JSON
            html = _BITRIX_IFRAME_HTML.format(brand=BRAND, url=status["support_url"], support=status["support"])
            return HTMLResponse(html, status_code=402)
        return JSONResponse(expired_payload(status), status_code=402, headers={"Cache-Control": "no-store"})
