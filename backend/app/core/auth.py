"""Lightweight JWT auth — opt-in via AUTH_ENABLED env var.

When `AUTH_ENABLED` is not "true", auth middleware is bypassed entirely and
the app behaves as before (no breaking change for existing deployments).

When enabled:
- POST /api/auth/login {username, password} → {access_token, role}
  Tries employee credentials first, falls back to ADMIN_PASSWORD env var.
- GET  /api/auth/me  → {username, role, emp_id}
- All other /api/* routes require `Authorization: Bearer <token>`
"""
import binascii
import hashlib
import os
from datetime import datetime, timedelta
from typing import Optional

import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

JWT_SECRET = os.getenv("JWT_SECRET", "dev-insecure-change-me-via-env")
JWT_ALGO = "HS256"
JWT_EXPIRE_HOURS = 24 * 7  # 7 days

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
AUTH_ENABLED = os.getenv("AUTH_ENABLED", "false").lower() == "true"


def _parse_static_users(raw: str) -> dict:
    """Parse AUTH_USERS env — "user1:pass1,user2:pass2" — all get role=admin.

    Passwords may not contain ':' or ','. Malformed entries are skipped.
    """
    users: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        uname, _, pwd = entry.partition(":")
        if uname.strip() and pwd:
            users[uname.strip()] = pwd
    return users


# Static admin users — ADMIN_USERNAME/ADMIN_PASSWORD pair plus any AUTH_USERS entries.
STATIC_USERS: dict[str, str] = _parse_static_users(os.getenv("AUTH_USERS", ""))
if ADMIN_PASSWORD:
    STATIC_USERS.setdefault(ADMIN_USERNAME, ADMIN_PASSWORD)


def is_auth_enabled() -> bool:
    return AUTH_ENABLED and bool(STATIC_USERS)


# ── Password hashing (stdlib PBKDF2, no external deps) ──────────────

def hash_password(plain: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"), salt, 100_000)
    return f"pbkdf2:sha256:100000:{binascii.hexlify(salt).decode()}:{binascii.hexlify(dk).decode()}"


def verify_password(plain: str, stored: str) -> bool:
    try:
        parts = stored.split(":")
        if len(parts) != 5 or parts[0] != "pbkdf2":
            return False
        _, algo, iters, salt_hex, hash_hex = parts
        salt = binascii.unhexlify(salt_hex)
        dk = hashlib.pbkdf2_hmac(algo, plain.encode("utf-8"), salt, int(iters))
        return binascii.hexlify(dk).decode() == hash_hex
    except Exception:
        return False


# ── JWT helpers ─────────────────────────────────────────────────────

def create_token(
    username: str,
    role: str = "admin",
    emp_id: Optional[int] = None,
) -> str:
    payload = {
        "sub": username,
        "role": role,
        "emp_id": emp_id,
        "iat": datetime.utcnow(),
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def verify_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        return None


# ── Routes ───────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: Optional[str] = None
    password: str


@router.get("/status")
def auth_status() -> dict:
    """Expose whether auth is enforced on this deployment."""
    return {
        "enabled": is_auth_enabled(),
        "admin_username": ADMIN_USERNAME if is_auth_enabled() else None,
    }


@router.post("/login")
def login(payload: LoginIn) -> dict:
    if not is_auth_enabled():
        return {"access_token": "auth-disabled", "token_type": "bearer", "username": "anon", "role": "admin"}

    uname = (payload.username or "").strip()
    pwd = payload.password

    # 1. Try employee credentials first
    try:
        from sqlmodel import Session, select

        from app.db import engine
        from app.models import EmployeeExtra

        with Session(engine) as s:
            emp = s.exec(
                select(EmployeeExtra).where(EmployeeExtra.login == uname)
            ).first()
        if emp and emp.password_hash and verify_password(pwd, emp.password_hash):
            role = emp.dashboard_role or "closer"
            token = create_token(uname, role=role, emp_id=emp.bitrix_user_id)
            return {
                "access_token": token,
                "token_type": "bearer",
                "username": uname,
                "role": role,
                "emp_id": emp.bitrix_user_id,
            }
    except Exception:
        pass  # DB not ready or other error — fall through to admin check

    # 2. Fall back to static admin users (ADMIN_USERNAME/ADMIN_PASSWORD + AUTH_USERS env)
    if not STATIC_USERS:
        raise HTTPException(status_code=500, detail="No auth users configured")
    if not uname or STATIC_USERS.get(uname) != pwd:
        raise HTTPException(status_code=401, detail="Login yoki parol noto'g'ri")
    token = create_token(uname, role="admin")
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": uname,
        "role": "admin",
        "emp_id": None,
    }


@router.get("/me")
def me(request: Request) -> dict:
    if not is_auth_enabled():
        return {"username": "anon", "auth_enabled": False, "role": "admin", "emp_id": None}
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Auth required")
    p = verify_token(auth[7:])
    if not p:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return {
        "username": p.get("sub", ""),
        "role": p.get("role", "admin"),
        "emp_id": p.get("emp_id"),
        "auth_enabled": True,
    }


# ── Middleware factory ───────────────────────────────────────────────

def install_auth_middleware(app):
    """Install on FastAPI app to enforce auth on /api/* (when enabled)."""

    PUBLIC_PREFIXES = (
        "/api/auth/",
        "/api/openapi.json",
        "/api/docs",
        "/api/config",
        "/api/bitrix/",
    )

    @app.middleware("http")
    async def _auth_mw(request: Request, call_next):
        if not is_auth_enabled():
            return await call_next(request)
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)
        if any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JSONResponse({"detail": "Auth required"}, status_code=401)
        if not verify_token(auth[7:]):
            return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)
        return await call_next(request)
