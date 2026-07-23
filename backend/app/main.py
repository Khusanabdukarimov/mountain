import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

_log = logging.getLogger(__name__)

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent          # backend/app/
BACKEND_DIR = APP_DIR.parent                       # backend/

load_dotenv(BACKEND_DIR / ".env")

from datetime import date
from typing import List

from app.api.routes import payroll as payroll_routes
from app.api.routes import call_stats as call_stats_routes
from app.core import auth as auth_module
from app.db import init_db, engine as _db_engine
from sqlmodel import Session as _Session, select as sql_select
from app.db_bx import init_bx_db, bx_engine
from sqlalchemy import text
from app.services import bitrix
from app.services import meta as meta_svc
from app.services.meta import MetaClient

app = FastAPI(openapi_url="/api/openapi.json", docs_url="/api/docs")

# Auth middleware (no-op unless AUTH_ENABLED=true env)
auth_module.install_auth_middleware(app)

# Serve uploaded avatars
AVATAR_DIR = BACKEND_DIR / "data" / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/avatars", StaticFiles(directory=str(AVATAR_DIR)), name="avatars")


@app.on_event("startup")
def _on_startup():
    init_db()
    init_bx_db()


app.include_router(payroll_routes.router)
app.include_router(auth_module.router)
app.include_router(call_stats_routes.router)


@app.get("/api/config")
def api_config():
    """Frontend bootstrap config — exposed safely to browser."""
    portal = bitrix.BITRIX24_PORTAL or ""
    # Strip trailing /rest/ to get base portal URL for UI links
    portal_base = portal.rstrip("/")
    if portal_base.endswith("/rest"):
        portal_base = portal_base[:-len("/rest")]
    return {
        "bitrix_portal": portal_base,
        "currency": {
            "primary": "UZS",
            "secondary": "USD",
        },
    }


# Legacy HTML root removed — React SPA at /var/www/mountain/frontend/app/dist
# is served by nginx. Backend is API-only.


class LeadCreate(BaseModel):
    date: Optional[str]
    employee_id: Optional[int]
    client: str
    source: Optional[str]
    amount: Optional[float] = 0.0
    status: Optional[str] = "NEW"
    deal_id: Optional[str]
    notes: Optional[str]


@app.get("/api/users")
def api_list_users():
    users = bitrix.list_users()
    return {"count": len(users), "users": users}


@app.post("/api/leads")
def api_create_lead(payload: LeadCreate):
    fields = {
        "TITLE": payload.client,
        "NAME": payload.client,
        "STATUS_ID": payload.status,
        "UF_CRM_1774413003006": payload.date,
    }
    if payload.employee_id:
        fields["ASSIGNED_BY_ID"] = payload.employee_id
    if payload.amount:
        # Bitrix expects MONEY fields often as custom fields on lead or as "OPPORTUNITY"
        fields["OPPORTUNITY"] = payload.amount
    if payload.notes:
        fields["COMMENTS"] = payload.notes

    res = bitrix.create_lead(fields)
    if not res:
        raise HTTPException(status_code=500, detail="Failed to create lead in Bitrix24")
    return {"result": res}


@app.get("/api/leads/{lead_id}")
def api_get_lead(lead_id: int):
    lead = bitrix.get_lead_details(lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return lead


# Removed: legacy demo /api/payroll/{emp_id} endpoint with hardcoded data.
# Use /api/payroll/calculate?bitrix_user_id=&year=&month= for real payroll
# (Bitrix won-deal revenue \u00d7 KPI tier + bonuses \u2212 penalties).


@app.get("/api/leads")
def api_leads(
    range: str = "all",
    responsible_id: Optional[int] = None,
    stage_id: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    limit: int = 50,
):
    offset = (page - 1) * limit
    days = None if range == "all" else (1 if range == "today" else int(range))
    days_interval = f"{days} days" if days is not None else None
    search_param = f"%{search}%" if search else None
    
    query = text("""
        SELECT
            l.id, l.title, l.name, l.last_name,
            l.opportunity, l.currency,
            l.is_won, l.is_failed, l.is_processed,
            l.date_create, l.date_modify,
            s.name_uz        AS stage_name,
            s.bitrix_id      AS stage_bitrix_id,
            TRIM(r.name || ' ' || COALESCE(r.last_name, '')) AS responsible_name,
            (SELECT phone FROM lead_phones lp
             WHERE lp.lead_id = l.id LIMIT 1) AS primary_phone,
            COUNT(*) OVER()  AS total_count
        FROM leads l
        LEFT JOIN stages       s ON s.id = l.stage_id
        LEFT JOIN responsibles r ON r.id = l.responsible_id
        WHERE
            (:days_interval IS NULL OR l.date_create >= NOW() - CAST(:days_interval AS INTERVAL))
            AND (:responsible_id IS NULL OR l.responsible_id = :responsible_id)
            AND (:stage_id IS NULL OR s.bitrix_id = :stage_id)
            AND (l.source_id IS NULL OR (l.source_id NOT ILIKE '%amocrm%' AND l.source_id != 'UC_1WUFJB'))
            AND (:search IS NULL OR l.name ILIKE :search
                                 OR l.last_name ILIKE :search
                                 OR l.title ILIKE :search
                                 OR EXISTS (
                                     SELECT 1 FROM lead_phones lp
                                     WHERE lp.lead_id = l.id AND lp.phone ILIKE :search
                                 ))
        ORDER BY l.date_create DESC
        LIMIT :limit OFFSET :offset;
    """)
    with bx_engine.connect() as conn:
        res = conn.execute(query, {
            "days_interval": days_interval,
            "responsible_id": responsible_id,
            "stage_id": stage_id,
            "search": search_param,
            "limit": limit,
            "offset": offset
        }).mappings().all()
    
    count = res[0]["total_count"] if res else 0
    return {"count": count, "leads": [dict(r) for r in res], "offset": offset, "limit": limit}


@app.get("/api/users/timeman")
def api_users_timeman():
    users = bitrix.list_users()
    result = []
    for u in users:
        uid = u.get("ID")
        tm = None
        if uid:
            try:
                tm = bitrix.get_timeman_status(uid)
            except Exception:
                pass
        full_name = f"{u.get('NAME', '')} {u.get('LAST_NAME', '')}".strip()
        result.append({
            "id": uid,
            "name": full_name,
            "email": u.get("EMAIL", ""),
            "active": u.get("ACTIVE", True),
            "work_position": u.get("WORK_POSITION", ""),
            "timeman": tm,
        })
    return {"count": len(result), "users": result}


@app.get("/api/deals/aggregate")
def api_deals_aggregate(user_id: int, start_date: str, end_date: str, stage: Optional[str] = None):
    res = bitrix.aggregate_deals_sum_by_user(user_id, start_date, end_date, stage_filter=stage)
    return res


# /api/stats, /api/responsibles, /api/conversion, /api/filter-options
# removed — all dashboard data now served by Node.js /api/dashboard/lead-*


@app.get("/api/dashboard/amocrm-sources")
def api_amocrm_sources():
    """Return amoCRM sub-source list from a local JSON fallback file when DB is not available.

    This endpoint is intentionally DB-free so the frontend can fetch amoCRM "Manba" options
    even when PostgreSQL is not configured.
    """
    # Possible locations for the fallback file: repo_root/bitrix-sync/amocrm_sources.json
    try:
        repo_root = BACKEND_DIR.parent
        candidates = [repo_root / 'bitrix-sync' / 'amocrm_sources.json', BACKEND_DIR / 'amocrm_sources.json']
        for p in candidates:
            try:
                if p.exists():
                    txt = p.read_text(encoding='utf8')
                    arr = json.loads(txt)
                    if isinstance(arr, list):
                        return arr
            except Exception:
                continue
    except Exception:
        pass
    # Fallback to an empty list if nothing is available.
    return []


@app.get("/api/stats/deals")
def api_stats_deals(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    assigned_by: Optional[int] = None,
    stage_id: Optional[str] = None,
    source_id: Optional[str] = None,
):
    conditions = ["1=1"]
    params: dict = {}
    if start_date:
        conditions.append("d.date_create >= :start_date")
        params["start_date"] = start_date
    if end_date:
        conditions.append("d.date_create < :end_date ::date + INTERVAL '1 day'")
        params["end_date"] = end_date
    if assigned_by:
        conditions.append("d.responsible_id = :assigned_by")
        params["assigned_by"] = assigned_by
    if stage_id:
        conditions.append("s.bitrix_id = :stage_id")
        params["stage_id"] = stage_id
    if source_id:
        conditions.append("d.source_id = :source_id")
        params["source_id"] = source_id
    where = "WHERE " + " AND ".join(conditions)

    with bx_engine.connect() as conn:
        stats = conn.execute(text(f"""
            SELECT
                COUNT(d.id)                                                      AS total,
                COUNT(d.id) FILTER (WHERE s.is_won)                             AS won_count,
                COUNT(d.id) FILTER (WHERE s.is_final AND NOT s.is_won)          AS lost_count,
                COALESCE(SUM(d.opportunity) FILTER (WHERE s.is_won), 0)         AS total_won_revenue,
                ROUND(COUNT(d.id) FILTER (WHERE s.is_won)::NUMERIC
                    / NULLIF(COUNT(d.id), 0) * 100, 2)                          AS conversion_rate
            FROM deals d
            LEFT JOIN stages s ON s.id = d.stage_id
            {where}
        """), params).mappings().first()

        stage_rows = conn.execute(text(f"""
            SELECT s.bitrix_id, s.name, COUNT(d.id) AS cnt
            FROM deals d
            LEFT JOIN stages s ON s.id = d.stage_id
            {where}
            GROUP BY s.bitrix_id, s.name
        """), params).mappings().all()

        all_stage_rows = conn.execute(text(
            "SELECT bitrix_id, name FROM stages WHERE entity = 'deal' ORDER BY sort_order"
        )).mappings().all()

        user_rows = conn.execute(text(f"""
            SELECT
                r.id                                                            AS responsible_id,
                TRIM(r.name || ' ' || COALESCE(r.last_name, ''))               AS full_name,
                s.bitrix_id                                                     AS stage_bitrix_id,
                COUNT(d.id)                                                     AS cnt,
                COALESCE(SUM(d.opportunity) FILTER (WHERE s.is_won), 0)        AS won_revenue
            FROM deals d
            LEFT JOIN stages s ON s.id = d.stage_id
            LEFT JOIN responsibles r ON r.id = d.responsible_id
            {where}
            GROUP BY r.id, r.name, r.last_name, s.bitrix_id
        """), params).mappings().all()

    by_stage = {r["bitrix_id"]: r["cnt"] for r in stage_rows if r["bitrix_id"]}
    stage_names = {r["bitrix_id"]: r["name"] for r in all_stage_rows}
    all_stages = [r["bitrix_id"] for r in all_stage_rows]

    user_map: dict = {}
    for r in user_rows:
        uid = str(r["responsible_id"] or "unknown")
        if uid not in user_map:
            user_map[uid] = {
                "id": uid,
                "name": r["full_name"] or f"User {uid}",
                "total": 0,
                "won_revenue": 0.0,
                "by_stage": {},
            }
        stage = r["stage_bitrix_id"] or "UNKNOWN"
        user_map[uid]["by_stage"][stage] = int(r["cnt"])
        user_map[uid]["total"] += int(r["cnt"])
        user_map[uid]["won_revenue"] += float(r["won_revenue"] or 0)

    by_user = sorted(user_map.values(), key=lambda x: -x["total"])
    return {
        "total":             int(stats["total"] or 0),
        "won_count":         int(stats["won_count"] or 0),
        "lost_count":        int(stats["lost_count"] or 0),
        "total_won_revenue": float(stats["total_won_revenue"] or 0),
        "conversion_rate":   float(stats["conversion_rate"] or 0),
        "by_stage":          by_stage,
        "by_user":           by_user,
        "all_stages":        all_stages,
        "stage_names":       stage_names,
        "users":             [{"id": u["id"], "name": u["name"]} for u in by_user],
    }


@app.get("/api/stats/deals/by-source")
def api_stats_deals_by_source(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    assigned_by: Optional[int] = None,
    stage_id: Optional[str] = None,
    source_id: Optional[str] = None,
):
    conditions = ["1=1"]
    params: dict = {}
    if start_date:
        conditions.append("d.date_create >= :start_date")
        params["start_date"] = start_date
    if end_date:
        conditions.append("d.date_create < :end_date ::date + INTERVAL '1 day'")
        params["end_date"] = end_date
    if assigned_by:
        conditions.append("d.responsible_id = :assigned_by")
        params["assigned_by"] = assigned_by
    if stage_id:
        conditions.append("s.bitrix_id = :stage_id")
        params["stage_id"] = stage_id
    if source_id:
        conditions.append("d.source_id = :source_id")
        params["source_id"] = source_id
    where = "WHERE " + " AND ".join(conditions)

    with bx_engine.connect() as conn:
        rows = conn.execute(text(f"""
            SELECT
                COALESCE(d.source_id, 'Noma''lum')                             AS source_id,
                COUNT(d.id)                                                     AS total,
                COUNT(d.id) FILTER (WHERE NOT s.is_final)                      AS ishlaydi,
                COUNT(d.id) FILTER (WHERE s.is_final AND NOT s.is_won)         AS provodka,
                COUNT(d.id) FILTER (WHERE s.is_won)                            AS success,
                COALESCE(SUM(d.opportunity) FILTER (WHERE s.is_won), 0)        AS revenue
            FROM deals d
            LEFT JOIN stages s ON s.id = d.stage_id
            {where}
            GROUP BY d.source_id
            ORDER BY total DESC
        """), params).mappings().all()

    sources = []
    source_names = {}
    for r in rows:
        src = r["source_id"]
        total = int(r["total"] or 0)
        success = int(r["success"] or 0)
        sources.append({
            "id":         src,
            "label":      src,
            "ishlaydi":   int(r["ishlaydi"] or 0),
            "provodka":   int(r["provodka"] or 0),
            "success":    success,
            "revenue":    float(r["revenue"] or 0),
            "total":      total,
            "conversion": round(success / total * 100, 2) if total else 0,
        })
        source_names[src] = src

    return {"sources": sources, "source_names": source_names}


@app.get("/api/meta/campaign-forms")
def api_meta_campaign_forms(ad_account_id: Optional[str] = None):
    """Return all campaigns that use lead gen (Instant Form) objectives,
    each with the list of instant forms attached via their adsets."""
    account_id = ad_account_id or meta_svc.META_AD_ACCOUNT
    if not account_id:
        raise HTTPException(status_code=400, detail="ad_account_id is required")
    if not account_id.startswith("act_"):
        account_id = f"act_{account_id}"
    campaigns = meta_svc.get_campaign_leadgen_forms(account_id)
    return {"count": len(campaigns), "campaigns": campaigns}


MONTH_NAMES_MAP = {
    "yanvar": 1, "fevral": 2, "mart": 3, "aprel": 4, "may": 5, "iyun": 6,
    "iyul": 7, "avgust": 8, "sentabr": 9, "oktabr": 10, "noyabr": 11, "dekabr": 12,
}

@app.get("/api/meta/page-forms")
def api_meta_page_forms(
    month: Optional[str] = None,
    year:  Optional[int] = None,
    from_date: Optional[str] = Query(None, alias="from"),
    to_date:   Optional[str] = Query(None, alias="to"),
):
    """Return per-form lead counts sourced from our facebook_leads DB table,
    filtered by from/to date range (preferred) or month/year fallback.
    """
    import requests as _req
    token = meta_svc._token()
    graph = meta_svc.GRAPH

    # ── Build date filter ────────────────────────────────────────────
    date_filter = ""
    date_params: dict = {}
    if from_date and to_date:
        # Explicit date range takes priority
        date_params = {"since": from_date, "until": to_date}
        date_filter = "AND (created_time AT TIME ZONE 'Asia/Tashkent')::date BETWEEN :since AND :until"
    elif month and year:
        m = MONTH_NAMES_MAP.get(month.lower())
        if m:
            import calendar
            last_day = calendar.monthrange(year, m)[1]
            date_params = {
                "since": f"{year}-{m:02d}-01",
                "until": f"{year}-{m:02d}-{last_day:02d}",
            }
            date_filter = "AND (created_time AT TIME ZONE 'Asia/Tashkent')::date BETWEEN :since AND :until"

    # ── Step 1: DB lead counts per form_id ──────────────────────────
    all_forms: dict = {}
    try:
        with bx_engine.connect() as conn:
            rows = conn.execute(text(f"""
                SELECT form_id,
                       COUNT(*)::int        AS leads_count,
                       MAX(created_time)    AS last_lead
                FROM facebook_leads
                WHERE form_id IS NOT NULL
                {date_filter}
                GROUP BY form_id
                ORDER BY leads_count DESC
            """), date_params).fetchall()
        for r in rows:
            all_forms[r[0]] = {
                "form_id":     r[0],
                "form_name":   r[0],   # placeholder — enriched below
                "status":      "ACTIVE",
                "leads_count": r[1],
                "created_time": str(r[2]) if r[2] else "",
            }
    except Exception as e:
        print(f"[page-forms] DB query error: {e}")

    # ── Step 2: fetch ALL forms from page using Page Token ──────────
    page_token = os.getenv("FB_PAGE_TOKEN", "")
    page_id    = os.getenv("FB_PAGE_ID", "")
    if page_token and page_id:
        try:
            pr = _req.get(f"{graph}/{page_id}/leadgen_forms", params={
                "access_token": page_token,
                "fields": "id,name,status,leads_count,created_time",
                "limit": 100,
            }, timeout=20)
            for f in pr.json().get("data", []):
                fid = f["id"]
                existing = all_forms.get(fid, {})
                all_forms[fid] = {
                    "form_id":      fid,
                    "form_name":    f.get("name", fid),
                    "status":       f.get("status", "ACTIVE"),
                    "leads_count":  existing.get("leads_count", 0),
                    "created_time": f.get("created_time", existing.get("created_time", "")),
                }
        except Exception as e:
            print(f"[page-forms] Page token fetch error: {e}")

    # ── Step 3: enrich names for any remaining forms via batch API ───
    no_name = [fid for fid, f in all_forms.items() if f["form_name"] == fid]
    try:
        for i in range(0, len(no_name), 50):
            chunk = no_name[i:i + 50]
            nr = _req.get(f"{graph}/", params={
                "access_token": token,
                "ids": ",".join(chunk),
                "fields": "id,name,status",
            }, timeout=15)
            for fid, fd in nr.json().items():
                if fid in all_forms:
                    all_forms[fid]["form_name"] = fd.get("name", fid)
                    all_forms[fid]["status"]    = fd.get("status", "ACTIVE")
    except Exception as e:
        print(f"[page-forms] Meta enrich error: {e}")

    # Add "U-Mark" prefix only for these two specific forms
    _UMARK_FORM_IDS = {"4348225758776030", "1709540397044785"}
    for fid, f in all_forms.items():
        if fid in _UMARK_FORM_IDS and not f["form_name"].startswith("U-Mark"):
            f["form_name"] = "U-Mark " + f["form_name"]

    # Exclude these forms from dashboard
    _EXCLUDED_FORM_IDS = {"1581692690210297"}  # Mountain | Nishonchi
    forms = [f for f in all_forms.values() if f["form_id"] not in _EXCLUDED_FORM_IDS]

    return {"forms": sorted(forms, key=lambda x: -(x["leads_count"] or 0))}


@app.get("/api/meta/accounts")
def api_meta_accounts():
    return meta_svc.get_ad_accounts()


@app.get("/api/meta/insights")
def api_meta_insights(
    month: str,
    year: int,
    ad_account_id: Optional[str] = None,
):
    import calendar
    month_num = meta_svc.MONTH_NAMES.get(month.lower())
    if not month_num:
        raise HTTPException(status_code=400, detail=f"Unknown month: {month}")
    days_in_month = calendar.monthrange(year, month_num)[1]
    since = f"{year}-{month_num:02d}-01"
    until = f"{year}-{month_num:02d}-{days_in_month:02d}"

    account_id = ad_account_id or meta_svc.META_AD_ACCOUNT
    if not account_id:
        raise HTTPException(status_code=400, detail="ad_account_id is required")

    rows = meta_svc.get_campaign_insights(account_id, since, until)
    if isinstance(rows, dict) and "error" in rows:
        raise HTTPException(status_code=400, detail=rows["error"])

    data = meta_svc.insights_to_monthly(rows, month, year)
    return {"month": month, "year": year, "data": data}


@app.get("/api/meta/campaigns")
def api_meta_campaigns(month: str, year: int, ad_account_id: Optional[str] = None):
    """Per-ad × platform breakdown — feeds Kampaniyalar page table."""
    import calendar as _cal
    month_num = meta_svc.MONTH_NAMES.get(month.lower())
    if not month_num:
        raise HTTPException(status_code=400, detail=f"Unknown month: {month}")
    days_in_month = _cal.monthrange(year, month_num)[1]
    since = f"{year}-{month_num:02d}-01"
    until = f"{year}-{month_num:02d}-{days_in_month:02d}"

    account_id = ad_account_id or meta_svc.META_AD_ACCOUNT
    if not account_id:
        raise HTTPException(status_code=400, detail="ad_account_id is required")

    rows = meta_svc.get_ad_breakdown(account_id, since, until)
    if isinstance(rows, dict) and "error" in rows:
        raise HTTPException(status_code=400, detail=rows["error"])

    return {"month": month, "year": year, "rows": meta_svc.ads_to_table(rows)}


# ────────────────────────────────────────────────────────────────────
# Marketing daily breakdown (Bitrix-derived metrics for Kunlik hisobot)
# ────────────────────────────────────────────────────────────────────
import calendar as _calendar
from datetime import datetime as _dt

# UTM_SOURCE (lower) or SOURCE_ID (upper) → bucket.
# Add aliases here if Bitrix data uses other tags.
_UTM_TO_SOURCE = {
    "instagram": "instagram", "ig": "instagram", "instagram_ads": "instagram", "ig_ads": "instagram",
    "facebook": "target", "fb": "target", "meta": "target",
    "facebook_ads": "target", "fb_ads": "target", "target": "target", "target_ads": "target",
}
_SOURCE_ID_TO_BUCKET = {
    "INSTAGRAM": "instagram", "IG": "instagram",
    "FACEBOOK": "target", "FB": "target", "META": "target", "TARGET": "target",
}

# Lead statuses considered "qualified" — mirrors JARAYON_STATUSES in /api/stats/leads.
_QUALIFIED_LEAD_STATUSES = {
    "IN_PROCESS", "PROCESSED", "UC_1KPATX", "UC_Q2U9EL", "UC_KXC3ZW", "UC_L28G68", "CONVERTED",
}

# "Sifatli lid" — the single definition shared with the Kampaniyalar page.
# Must stay identical to the stage list in bitrix-sync/src/api/campaigns.js
# (/form-stats, /forms, /creatives), otherwise the two pages disagree.
_SIFATLI_STAGES = [
    "THINKING", "UC_KXC3ZW", "CONSULTATION", "UC_L28G68", "NOT_TRANSFERRED",
    "UC_5G8244", "CONVERTED_CONSULT", "CONVERTED", "UC_NAZK5J", "RECYCLED",
]
# "Bekor bo'ldi" — a subset of sifatli (the lead qualified, then cancelled).
_BEKOR_STAGES = ["UC_NAZK5J", "JUNK"]
# "Sifatsiz" — the lead was disqualified (junk / not a real prospect).
_SIFATSIZ_STAGES = ["UC_F8K4GI"]


def _classify_source(utm_source, source_id=None):
    bucket = _UTM_TO_SOURCE.get((utm_source or "").strip().lower())
    if bucket:
        return bucket
    return _SOURCE_ID_TO_BUCKET.get((source_id or "").strip().upper())


def _stage_is_won(stage_id):
    s = str(stage_id or "").upper()
    return s == "WON" or s.endswith(":WON")


def _parse_bitrix_day(date_str, year: int, month_num: int):
    if not date_str:
        return None
    try:
        dt = _dt.fromisoformat(date_str.replace("Z", "+00:00"))
    except Exception:
        try:
            dt = _dt.strptime(date_str[:10], "%Y-%m-%d")
        except Exception:
            return None
    if dt.year != year or dt.month != month_num:
        return None
    return dt.day


@app.get("/api/marketing/bitrix-daily")
def api_marketing_bitrix_daily(month: str, year: int):
    """Daily breakdown of Bitrix-derived metrics for the Kunlik hisobot table.

    Per-day arrays (length = days in month) bucketed by source (UTM_SOURCE):
      - sales_sum, sales_count: WON deals by CLOSEDATE
      - deals:                  all deals created (DATE_CREATE)
      - qual_leads:             leads with qualifying STATUS_ID by DATE_CREATE
    """
    month_num = meta_svc.MONTH_NAMES.get(month.lower())
    if not month_num:
        raise HTTPException(status_code=400, detail=f"Unknown month: {month}")
    days_in_month = _calendar.monthrange(year, month_num)[1]
    since = f"{year}-{month_num:02d}-01"
    until = f"{year}-{month_num:02d}-{days_in_month:02d}T23:59:59"

    metrics = ("sales_sum", "sales_count", "qual_leads", "deals")
    result = {src: {m: [0] * days_in_month for m in metrics} for src in ("target", "instagram")}

    deals_closed = bitrix.list_deals(
        filter_dict={">=CLOSEDATE": since, "<=CLOSEDATE": until},
        select=["ID", "OPPORTUNITY", "CLOSEDATE", "STAGE_ID", "UTM_SOURCE", "SOURCE_ID"],
    )
    for d in deals_closed:
        src = _classify_source(d.get("UTM_SOURCE"), d.get("SOURCE_ID"))
        if src is None or not _stage_is_won(d.get("STAGE_ID")):
            continue
        day = _parse_bitrix_day(d.get("CLOSEDATE"), year, month_num)
        if day is None:
            continue
        try:
            opp = float(d.get("OPPORTUNITY") or 0)
        except Exception:
            opp = 0.0
        result[src]["sales_sum"][day - 1] += opp
        result[src]["sales_count"][day - 1] += 1

    deals_created = bitrix.list_deals(
        filter_dict={">=DATE_CREATE": since, "<=DATE_CREATE": until},
        select=["ID", "DATE_CREATE", "UTM_SOURCE", "SOURCE_ID"],
    )
    for d in deals_created:
        src = _classify_source(d.get("UTM_SOURCE"), d.get("SOURCE_ID"))
        if src is None:
            continue
        day = _parse_bitrix_day(d.get("DATE_CREATE"), year, month_num)
        if day is None:
            continue
        result[src]["deals"][day - 1] += 1

    leads = bitrix.list_leads(
        filter_dict={">=DATE_CREATE": since, "<=DATE_CREATE": until},
        select=["ID", "DATE_CREATE", "STATUS_ID", "UTM_SOURCE", "SOURCE_ID"],
    )
    for l in leads:
        src = _classify_source(l.get("UTM_SOURCE"), l.get("SOURCE_ID"))
        if src is None or l.get("STATUS_ID") not in _QUALIFIED_LEAD_STATUSES:
            continue
        day = _parse_bitrix_day(l.get("DATE_CREATE"), year, month_num)
        if day is None:
            continue
        result[src]["qual_leads"][day - 1] += 1

    return {"month": month, "year": year, "data": result}


@app.get("/api/marketing/kunlik")
def api_marketing_kunlik(month: str, year: int, targetolog: str = "all", responsible_id: str = ""):
    """Daily CRM metrics from Bitrix24 — Facebook (target) and Instagram only.

    Metrics per section (target / instagram), per day array:
      leads        — total leads by DATE_CREATE
      qual_leads   — leads at qualifying stages (Sifatli lid)
      meetings     — deals at "Uchrashuv o'tkazildi" stage (consultation done)
      deals        — deals at "Kelishuv bo'ldi" stage
      deals_sum    — opportunity sum at Kelishuv stage
      sales_count  — deals at "Ish boshlandi"/"Sotuv bo'ldi" stages
      sales_sum    — opportunity sum at Sotuv/Ish boshlandi stages
      cancelled    — leads at "Bekor bo'ldi" stage

    targetolog: "all" | "islomiddin" | "dilmurod"
    """
    from app.db_bx import bx_engine as _bxe
    from sqlalchemy import text as _text

    month_key = month.lower()
    month_num = meta_svc.MONTH_NAMES.get(month_key)
    if not month_num:
        raise HTTPException(status_code=400, detail=f"Unknown month: {month}")

    days_in_month = _calendar.monthrange(year, month_num)[1]
    since = f"{year}-{month_num:02d}-01"
    until = f"{year}-{month_num:02d}-{days_in_month:02d}"

    _METRICS = ["leads", "qual_leads", "meetings", "deals", "deals_sum", "sales_count", "sales_sum", "cancelled", "sifatsiz"]
    result = {"target": {m: [0.0] * days_in_month for m in _METRICS}}
    result["unmatched"] = {"sales_count": [0.0] * days_in_month, "sales_sum": [0.0] * days_in_month}

    # Target source_id in Bitrix24 = UC_89FPH6
    TARGET_SRC = "UC_89FPH6"

    resp_ids = [int(x) for x in responsible_id.split(",") if x.strip().isdigit()] if responsible_id else []
    resp_fb   = "AND (le.responsible_id = ANY(:resp_ids) OR d.responsible_id = ANY(:resp_ids))" if resp_ids else ""
    resp_deal = "AND d.responsible_id = ANY(:resp_ids)" if resp_ids else ""

    targ_keys = [t.strip().lower() for t in targetolog.split(",") if t.strip() and t.strip() != "all"]

    # Fetch campaign assignments from DB (no pattern logic — DB is sole source of truth)
    _assigned_campaigns: list[str] = []
    if targ_keys:
        try:
            with _bxe.connect() as _oc:
                _override_rows = _oc.execute(
                    _text("SELECT campaign_name, targetolog FROM campaign_targetolog_overrides WHERE targetolog IS NOT NULL")
                ).fetchall()
            _assigned_campaigns = [r[0] for r in _override_rows if r[1] and r[1].lower() in targ_keys]
        except Exception:
            pass

    def _build_campaign_filter(alias: str, params: dict, column: str = "utm_campaign") -> str:
        """Build utm_campaign WHERE clause using DB assignments only."""
        if not targ_keys:
            return ""
        if not _assigned_campaigns:
            return "AND FALSE"
        keys = []
        for n in _assigned_campaigns:
            key = f"ca{len(params)}"
            params[key] = n
            keys.append(f":{key}")
        return f"AND {alias}.{column} IN ({', '.join(keys)})"

    with _bxe.connect() as conn:
        # ── LEAD metrics ──────────────────────────────────────────────
        # Counted from facebook_leads (Meta form submissions), phone-matched to
        # Bitrix — the same basis as the Kampaniyalar page, so the two agree.
        # Counting the Bitrix `leads` table instead would silently drop every
        # returning contact: upsertLead dedupes by phone, so a repeat submitter
        # reuses their old lead row and produces no lead dated on the day they
        # actually filled the form.
        lead_params: dict = {
            "since": since, "until": until,
            "sifatli": _SIFATLI_STAGES, "bekor": _BEKOR_STAGES,
        }
        if resp_ids:
            lead_params["resp_ids"] = resp_ids
        lead_campaign_filter = _build_campaign_filter("fl", lead_params, "campaign_name")

        lead_sql = _text(f"""
            SELECT
                EXTRACT(DAY FROM (fl.created_time AT TIME ZONE 'Asia/Tashkent'))::int AS day,
                COUNT(DISTINCT fl.phone_norm) AS leads,
                COUNT(DISTINCT CASE WHEN (le.id     IS NOT NULL AND s.bitrix_id  = ANY(:sifatli))
                                      OR (dp.deal_id IS NOT NULL AND ds.bitrix_id = ANY(:sifatli))
                                    THEN fl.phone_norm END) AS qual_leads,
                COUNT(DISTINCT CASE WHEN s.bitrix_id = ANY(:bekor) OR ds.bitrix_id = ANY(:bekor)
                                    THEN fl.phone_norm END) AS cancelled
            FROM facebook_leads fl
            LEFT JOIN lead_phones lp
              ON RIGHT(REGEXP_REPLACE(lp.phone, '[^0-9]', '', 'g'), 9)
               = RIGHT(REGEXP_REPLACE(fl.phone, '[^0-9]', '', 'g'), 9)
             AND RIGHT(REGEXP_REPLACE(fl.phone, '[^0-9]', '', 'g'), 9) <> ''
            LEFT JOIN leads  le ON le.id = lp.lead_id
            LEFT JOIN stages s  ON s.id  = le.stage_id AND s.entity = 'lead'
            LEFT JOIN deal_phones dp
              ON RIGHT(REGEXP_REPLACE(dp.phone, '[^0-9]', '', 'g'), 9)
               = RIGHT(REGEXP_REPLACE(fl.phone, '[^0-9]', '', 'g'), 9)
             AND RIGHT(REGEXP_REPLACE(fl.phone, '[^0-9]', '', 'g'), 9) <> ''
            LEFT JOIN deals  d  ON d.id  = dp.deal_id AND d.lead_id IS NULL
            LEFT JOIN stages ds ON ds.id = d.stage_id AND ds.entity = 'deal'
            WHERE (fl.created_time AT TIME ZONE 'Asia/Tashkent')::date BETWEEN :since AND :until
              -- Drop junk-phone spam ("1","7888"...) and count each PERSON once
              -- per day (fl.phone_norm), not each raw submission (fl.id) — a
              -- returning contact filling the form twice the same day should
              -- count once, matching Meta's own per-day account attribution.
              AND LENGTH(fl.phone_norm) >= 9
              {lead_campaign_filter}
              {resp_fb}
            GROUP BY 1
        """)
        # Note: no "AND fl.campaign_name IS NOT NULL" — /creatives counts
        # campaign-less FB leads too (as 'N/A'), so adding that filter would
        # break the "all targetologs" case.
        for day, leads, qual_leads, cancelled in conn.execute(lead_sql, lead_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            idx = int(day) - 1
            result["target"]["leads"][idx]      += int(leads)
            result["target"]["qual_leads"][idx] += int(qual_leads)
            result["target"]["cancelled"][idx]  += int(cancelled)

        # ── SIFATSIZ (Bitrix leads in UC_F8K4GI, source=Target) ──────────
        # Uses Bitrix leads directly (like the Voronka/Dashboard), NOT the
        # facebook_leads phone-match, so the two pages agree on Sifatsiz.
        sifatsiz_params: dict = {"since": since, "until": until, "src": TARGET_SRC,
                                 "sifatsiz": _SIFATSIZ_STAGES}
        if resp_ids:
            sifatsiz_params["resp_ids"] = resp_ids
        sifatsiz_campaign_filter = _build_campaign_filter("l", sifatsiz_params)
        resp_lead = "AND l.responsible_id = ANY(:resp_ids)" if resp_ids else ""
        sifatsiz_sql = _text(f"""
            SELECT EXTRACT(DAY FROM l.date_create AT TIME ZONE 'Asia/Tashkent')::int AS day,
                   COUNT(*) AS cnt
            FROM leads l
            JOIN stages s ON s.id = l.stage_id AND s.entity = 'lead'
                         AND s.bitrix_id = ANY(:sifatsiz)
            WHERE (l.date_create AT TIME ZONE 'Asia/Tashkent')::date BETWEEN :since AND :until
              AND l.source_id = :src
              {sifatsiz_campaign_filter}
              {resp_lead}
            GROUP BY 1
        """)
        for day, cnt in conn.execute(sifatsiz_sql, sifatsiz_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            result["target"]["sifatsiz"][int(day) - 1] += int(cnt)

        # ── DEAL metrics (meetings, shartnoma) by date_create ───────────
        deal_params: dict = {"since": since, "until": until, "src": TARGET_SRC}
        if resp_ids:
            deal_params["resp_ids"] = resp_ids
        deal_campaign_filter = _build_campaign_filter("l_deal", deal_params)

        deal_sql = _text(f"""
            SELECT
                EXTRACT(DAY FROM d.date_create AT TIME ZONE 'Asia/Tashkent')::int AS day,
                s.bitrix_id AS stage_bid,
                s.is_won,
                s.is_final,
                CASE WHEN d.currency_id = 'USD' THEN COALESCE(d.opportunity, 0) ELSE 0 END AS opp
            FROM deals d
            LEFT JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
            LEFT JOIN leads l_deal ON l_deal.id = d.lead_id
            WHERE d.date_create::date BETWEEN :since AND :until
              AND d.source_id = :src
              AND d.category_id = 0
              {deal_campaign_filter}
              {resp_deal}
        """)
        for day, stage_bid, is_won, is_final, opp in conn.execute(deal_sql, deal_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            idx = int(day) - 1
            # NB: open deals must NOT be added to qual_leads — "Maqsadli lidlar
            # soni" counts leads, and every open deal here already comes from a
            # lead that the query above counted.
            # Every deal in this pipeline (category_id=0) is created AT the
            # "Uchrashuv o'tkazildi" stage, so any deal that exists — regardless
            # of its current stage — already had its meeting counted once.
            result["target"]["meetings"][idx] += 1
            if stage_bid == "UC_W35V62" or is_won:
                result["target"]["deals"][idx] += 1
                result["target"]["deals_sum"][idx] += float(opp)

        # ── SALES metrics by uf_bp_sale_date via facebook_leads match ──
        # Same attribution as Kampaniya page: Path A (lead_phones) + Path B (deal_phones)
        sale_params: dict = {"since": since, "until": until}
        if resp_ids:
            sale_params["resp_ids"] = resp_ids

        # Build campaign IN clause for both EXISTS subqueries
        if targ_keys and _assigned_campaigns:
            _ck: list[str] = []
            for _n in _assigned_campaigns:
                _k = f"sc{len(sale_params)}"
                sale_params[_k] = _n
                _ck.append(f":{_k}")
            _camp_in = f"IN ({', '.join(_ck)})"
            _camp_filter_a = f"AND fl_a.campaign_name {_camp_in}"
            _camp_filter_b = f"AND fl_b.campaign_name {_camp_in}"
        elif targ_keys:
            _camp_filter_a = "AND FALSE"
            _camp_filter_b = "AND FALSE"
        else:
            _camp_filter_a = ""
            _camp_filter_b = ""

        if targ_keys:
            # Targetolog filtered: only FB-attributed deals for selected campaigns
            sale_sql = _text(f"""
                SELECT
                    EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                  {resp_deal}
                  AND (
                    EXISTS (
                      SELECT 1 FROM leads le
                      JOIN lead_phones lp ON lp.lead_id = le.id
                      JOIN facebook_leads fl_a ON
                        RIGHT(REGEXP_REPLACE(fl_a.phone,'[^0-9]','','g'),9)
                        = RIGHT(REGEXP_REPLACE(lp.phone,'[^0-9]','','g'),9)
                        AND fl_a.campaign_name = le.utm_campaign
                      WHERE le.id = d.lead_id
                        {_camp_filter_a}
                    )
                    OR EXISTS (
                      SELECT 1 FROM deal_phones dp
                      JOIN facebook_leads fl_b ON
                        RIGHT(REGEXP_REPLACE(fl_b.phone,'[^0-9]','','g'),9)
                        = RIGHT(REGEXP_REPLACE(dp.phone,'[^0-9]','','g'),9)
                      WHERE dp.deal_id = d.id
                        {_camp_filter_b}
                    )
                  )
            """)
            payment_sql = _text(f"""
                SELECT day, SUM(paid) AS opp FROM (
                    SELECT EXTRACT(DAY FROM p.paid_at AT TIME ZONE 'Asia/Tashkent')::int AS day,
                           p.amount_usd AS paid
                    FROM deals d
                    JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                    JOIN deal_payments p ON p.deal_id = d.id
                    WHERE p.paid_at::date BETWEEN :since AND :until
                      {resp_deal}
                      AND (
                        EXISTS (
                          SELECT 1 FROM leads le
                          JOIN lead_phones lp ON lp.lead_id = le.id
                          JOIN facebook_leads fl_a ON
                            RIGHT(REGEXP_REPLACE(fl_a.phone,'[^0-9]','','g'),9)
                            = RIGHT(REGEXP_REPLACE(lp.phone,'[^0-9]','','g'),9)
                            AND fl_a.campaign_name = le.utm_campaign
                          WHERE le.id = d.lead_id
                            {_camp_filter_a}
                        )
                        OR EXISTS (
                          SELECT 1 FROM deal_phones dp
                          JOIN facebook_leads fl_b ON
                            RIGHT(REGEXP_REPLACE(fl_b.phone,'[^0-9]','','g'),9)
                            = RIGHT(REGEXP_REPLACE(dp.phone,'[^0-9]','','g'),9)
                          WHERE dp.deal_id = d.id
                            {_camp_filter_b}
                        )
                      )
                    UNION ALL
                    SELECT EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day,
                           d.uf_paid_sum AS paid
                    FROM deals d
                    JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                    WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                      {resp_deal}
                      AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
                      AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
                      AND (
                        EXISTS (
                          SELECT 1 FROM leads le
                          JOIN lead_phones lp ON lp.lead_id = le.id
                          JOIN facebook_leads fl_a ON
                            RIGHT(REGEXP_REPLACE(fl_a.phone,'[^0-9]','','g'),9)
                            = RIGHT(REGEXP_REPLACE(lp.phone,'[^0-9]','','g'),9)
                            AND fl_a.campaign_name = le.utm_campaign
                          WHERE le.id = d.lead_id
                            {_camp_filter_a}
                        )
                        OR EXISTS (
                          SELECT 1 FROM deal_phones dp
                          JOIN facebook_leads fl_b ON
                            RIGHT(REGEXP_REPLACE(fl_b.phone,'[^0-9]','','g'),9)
                            = RIGHT(REGEXP_REPLACE(dp.phone,'[^0-9]','','g'),9)
                          WHERE dp.deal_id = d.id
                            {_camp_filter_b}
                        )
                      )
                ) sub GROUP BY day
            """)
        else:
            # No targetolog filter: all won Target deals (matched + unmatched)
            sale_sql = _text(f"""
                SELECT
                    EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                  AND d.source_id = :src
                  {resp_deal}
            """)
            payment_sql = _text(f"""
                SELECT day, SUM(paid) AS opp FROM (
                    SELECT EXTRACT(DAY FROM p.paid_at AT TIME ZONE 'Asia/Tashkent')::int AS day,
                           p.amount_usd AS paid
                    FROM deals d
                    JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                    JOIN deal_payments p ON p.deal_id = d.id
                    WHERE p.paid_at::date BETWEEN :since AND :until
                      AND d.source_id = :src
                      {resp_deal}
                    UNION ALL
                    SELECT EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day,
                           d.uf_paid_sum AS paid
                    FROM deals d
                    JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                    WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                      AND d.source_id = :src
                      {resp_deal}
                      AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
                      AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
                ) sub GROUP BY day
            """)
            sale_params["src"] = TARGET_SRC
        for (day,) in conn.execute(sale_sql, sale_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            result["target"]["sales_count"][int(day) - 1] += 1
        for day, opp in conn.execute(payment_sql, sale_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            result["target"]["sales_sum"][int(day) - 1] += float(opp)

        # ── UNMATCHED sales (won Target deals NOT linked to any FB campaign) ──
        unmatched_params = {"since": since, "until": until, "src": TARGET_SRC}
        if resp_ids:
            unmatched_params["resp_ids"] = resp_ids
        unmatched_sql = _text(f"""
            SELECT
                EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day
            FROM deals d
            JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
            WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
              AND d.source_id = :src
              {resp_deal}
              AND NOT EXISTS (
                SELECT 1 FROM leads le
                JOIN lead_phones lp ON lp.lead_id = le.id
                JOIN facebook_leads fl ON
                  RIGHT(REGEXP_REPLACE(fl.phone,'[^0-9]','','g'),9)
                  = RIGHT(REGEXP_REPLACE(lp.phone,'[^0-9]','','g'),9)
                  AND fl.campaign_name = le.utm_campaign
                WHERE le.id = d.lead_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM deal_phones dp
                JOIN facebook_leads fl ON
                  RIGHT(REGEXP_REPLACE(fl.phone,'[^0-9]','','g'),9)
                  = RIGHT(REGEXP_REPLACE(dp.phone,'[^0-9]','','g'),9)
                WHERE dp.deal_id = d.id
              )
        """)
        unmatched_payment_sql = _text(f"""
            SELECT day, SUM(paid) AS opp FROM (
                SELECT EXTRACT(DAY FROM p.paid_at AT TIME ZONE 'Asia/Tashkent')::int AS day,
                       p.amount_usd AS paid
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                JOIN deal_payments p ON p.deal_id = d.id
                WHERE p.paid_at::date BETWEEN :since AND :until
                  AND d.source_id = :src
                  {resp_deal}
                  AND NOT EXISTS (
                    SELECT 1 FROM leads le
                    JOIN lead_phones lp ON lp.lead_id = le.id
                    JOIN facebook_leads fl ON
                      RIGHT(REGEXP_REPLACE(fl.phone,'[^0-9]','','g'),9)
                      = RIGHT(REGEXP_REPLACE(lp.phone,'[^0-9]','','g'),9)
                      AND fl.campaign_name = le.utm_campaign
                    WHERE le.id = d.lead_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM deal_phones dp
                    JOIN facebook_leads fl ON
                      RIGHT(REGEXP_REPLACE(fl.phone,'[^0-9]','','g'),9)
                      = RIGHT(REGEXP_REPLACE(dp.phone,'[^0-9]','','g'),9)
                    WHERE dp.deal_id = d.id
                  )
                UNION ALL
                SELECT EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day,
                       d.uf_paid_sum AS paid
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                  AND d.source_id = :src
                  {resp_deal}
                  AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
                  AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
                  AND NOT EXISTS (
                    SELECT 1 FROM leads le
                    JOIN lead_phones lp ON lp.lead_id = le.id
                    JOIN facebook_leads fl ON
                      RIGHT(REGEXP_REPLACE(fl.phone,'[^0-9]','','g'),9)
                      = RIGHT(REGEXP_REPLACE(lp.phone,'[^0-9]','','g'),9)
                      AND fl.campaign_name = le.utm_campaign
                    WHERE le.id = d.lead_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM deal_phones dp
                    JOIN facebook_leads fl ON
                      RIGHT(REGEXP_REPLACE(fl.phone,'[^0-9]','','g'),9)
                      = RIGHT(REGEXP_REPLACE(dp.phone,'[^0-9]','','g'),9)
                    WHERE dp.deal_id = d.id
                  )
            ) sub GROUP BY day
        """)
        for (day,) in conn.execute(unmatched_sql, unmatched_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            result["unmatched"]["sales_count"][int(day) - 1] += 1
        for day, opp in conn.execute(unmatched_payment_sql, unmatched_params):
            if day is None or day < 1 or day > days_in_month:
                continue
            result["unmatched"]["sales_sum"][int(day) - 1] += float(opp)

    # Convert float arrays to int where appropriate
    int_keys = {"leads", "qual_leads", "meetings", "deals", "sales_count", "cancelled", "sifatsiz"}
    for sec in result.values():
        for k in int_keys:
            if k in sec:
                sec[k] = [int(v) for v in sec[k]]

    return {"month": month, "year": year, "data": result}


@app.get("/api/marketing/kunlik-meta")
def api_marketing_kunlik_meta(month: str, year: int):
    """Return saved plan targets and day overrides for the Kunlik hisobot table."""
    from app.models import KunlikPlan, KunlikOverride
    month = month.lower()
    with _Session(_db_engine) as s:
        plans_rows = s.exec(
            sql_select(KunlikPlan).where(
                KunlikPlan.month == month, KunlikPlan.year == year
            )
        ).all()
        override_rows = s.exec(
            sql_select(KunlikOverride).where(
                KunlikOverride.month == month, KunlikOverride.year == year
            )
        ).all()

    plans: dict = {"target": {}, "instagram": {}}
    for row in plans_rows:
        if row.section not in plans:
            plans[row.section] = {}
        plans[row.section][row.metric_key] = row.value

    overrides: dict = {"target": {}, "instagram": {}}
    for row in override_rows:
        if row.section not in overrides:
            overrides[row.section] = {}
        sec = overrides[row.section]
        if row.metric_key not in sec:
            sec[row.metric_key] = {}
        sec[row.metric_key][row.day] = row.value

    return {"plans": plans, "overrides": overrides}


class KunlikPlanBody(BaseModel):
    section: str
    metric_key: str
    month: str
    year: int
    value: float


@app.put("/api/marketing/kunlik-plan")
def api_marketing_kunlik_plan(body: KunlikPlanBody):
    """Upsert a monthly plan target for one metric."""
    from app.models import KunlikPlan
    month = body.month.lower()
    with _Session(_db_engine) as s:
        existing = s.exec(
            sql_select(KunlikPlan).where(
                KunlikPlan.section == body.section,
                KunlikPlan.metric_key == body.metric_key,
                KunlikPlan.month == month,
                KunlikPlan.year == body.year,
            )
        ).first()
        if existing:
            existing.value = body.value
            s.add(existing)
        else:
            s.add(KunlikPlan(
                section=body.section, metric_key=body.metric_key,
                month=month, year=body.year, value=body.value,
            ))
        s.commit()
    return {"ok": True}


class KunlikOverrideBody(BaseModel):
    section: str
    metric_key: str
    month: str
    year: int
    day: int
    value: Optional[float]


@app.put("/api/marketing/kunlik-override")
def api_marketing_kunlik_override(body: KunlikOverrideBody):
    """Upsert or delete a single-day override value."""
    from app.models import KunlikOverride
    month = body.month.lower()
    with _Session(_db_engine) as s:
        existing = s.exec(
            sql_select(KunlikOverride).where(
                KunlikOverride.section == body.section,
                KunlikOverride.metric_key == body.metric_key,
                KunlikOverride.month == month,
                KunlikOverride.year == body.year,
                KunlikOverride.day == body.day,
            )
        ).first()
        if body.value is None:
            if existing:
                s.delete(existing)
        else:
            if existing:
                existing.value = body.value
                s.add(existing)
            else:
                s.add(KunlikOverride(
                    section=body.section, metric_key=body.metric_key,
                    month=month, year=body.year, day=body.day, value=body.value,
                ))
        s.commit()
    return {"ok": True}


# ── Custom metric sections ──────────────────────────────────────────

@app.get("/api/marketing/lead-sources")
def api_lead_sources():
    """Return distinct source_id values from leads table with counts."""
    with bx_engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT source_id, COUNT(*) AS cnt
            FROM leads
            WHERE source_id IS NOT NULL AND source_id != ''
            GROUP BY source_id
            ORDER BY cnt DESC
        """)).fetchall()
    return {"sources": [{"id": r[0], "count": int(r[1])} for r in rows]}

# Map Bitrix24 UF field ID → leads/deals DB column name
_UF_LEAD_COL = {
    "UF_CRM_1775824803703": "uf_service",
    "SOURCE_ID": "source_id",
}
_UF_DEAL_COL = {
    "UF_CRM_69D8F71700936": "uf_service",
    "SOURCE_ID": "source_id",
}


@app.get("/api/marketing/kunlik-sections")
def list_kunlik_sections():
    from app.models import KunlikCustomSection
    with _Session(_db_engine) as s:
        rows = s.exec(sql_select(KunlikCustomSection).order_by(KunlikCustomSection.sort_order, KunlikCustomSection.id)).all()
    return {"sections": [
        {"id": r.id, "title": r.title, "uf_field": r.uf_field, "uf_field_deal": r.uf_field_deal,
         "source_names": r.source_names, "color": r.color}
        for r in rows
    ]}


class KunlikSectionBody(BaseModel):
    title: str
    uf_field: str = "SOURCE_ID"
    uf_field_deal: str = "SOURCE_ID"
    source_names: List[str] = []
    color: str = "#6366f1"


@app.post("/api/marketing/kunlik-sections")
def create_kunlik_section(body: KunlikSectionBody):
    from app.models import KunlikCustomSection
    with _Session(_db_engine) as s:
        sec = KunlikCustomSection(
            title=body.title,
            uf_field=body.uf_field,
            uf_field_deal=body.uf_field_deal,
            source_names=body.source_names,
            color=body.color,
        )
        s.add(sec)
        s.commit()
        s.refresh(sec)
        return {"id": sec.id, "title": sec.title, "uf_field": sec.uf_field,
                "uf_field_deal": sec.uf_field_deal, "source_names": sec.source_names, "color": sec.color}


@app.delete("/api/marketing/kunlik-sections/{section_id}")
def delete_kunlik_section(section_id: int):
    from app.models import KunlikCustomSection
    with _Session(_db_engine) as s:
        sec = s.get(KunlikCustomSection, section_id)
        if not sec:
            raise HTTPException(status_code=404, detail="Section not found")
        s.delete(sec)
        s.commit()
    return {"ok": True}


@app.get("/api/marketing/kunlik-segment")
def api_marketing_kunlik_segment(section_id: int, month: str, year: int, responsible_id: str = ""):
    """Return per-day metrics for a custom section filtered by uf_service values."""
    from app.models import KunlikCustomSection
    from app.db_bx import bx_engine as _bxe
    from sqlalchemy import text as _text

    with _Session(_db_engine) as s:
        sec = s.get(KunlikCustomSection, section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Section not found")

    source_names: list = sec.source_names or []
    lead_col = _UF_LEAD_COL.get(sec.uf_field)
    deal_col = _UF_DEAL_COL.get(sec.uf_field_deal)

    month_key = month.lower()
    month_num = meta_svc.MONTH_NAMES.get(month_key)
    if not month_num:
        raise HTTPException(status_code=400, detail=f"Unknown month: {month}")

    days_in_month = _calendar.monthrange(year, month_num)[1]
    since = f"{year}-{month_num:02d}-01"
    until = f"{year}-{month_num:02d}-{days_in_month:02d}"

    resp_ids = [int(x) for x in responsible_id.split(",") if x.strip().isdigit()] if responsible_id else []
    resp_filter_lead = "AND l.responsible_id = ANY(:resp_ids)" if resp_ids else ""
    resp_filter_deal = "AND d.responsible_id = ANY(:resp_ids)" if resp_ids else ""

    _METRICS = ["leads", "qual_leads", "meetings", "deals", "deals_sum", "sales_count", "sales_sum", "cancelled", "sifatsiz"]
    result = {m: [0.0] * days_in_month for m in _METRICS}

    _QUAL_STAGES = {"IN_PROCESS", "PROCESSED", "UC_1KPATX", "UC_Q2U9EL", "UC_KXC3ZW", "UC_L28G68", "CONVERTED"}
    _CANCEL_STAGES = {"UC_NAZK5J", "JUNK"}

    with _bxe.connect() as conn:
        # ── Lead metrics ───────────────────────────────────────────
        if lead_col and source_names:
            lead_sql = _text(f"""
                SELECT
                    EXTRACT(DAY FROM l.date_create)::int AS day,
                    s.bitrix_id AS stage_bid,
                    COUNT(*) AS cnt
                FROM leads l
                JOIN stages s ON s.id = l.stage_id AND s.entity = 'lead'
                WHERE l.date_create::date BETWEEN :since AND :until
                  AND l.{lead_col} = ANY(:names)
                  {resp_filter_lead}
                GROUP BY 1, 2
            """)
            params = {"since": since, "until": until, "names": source_names}
            if resp_ids: params["resp_ids"] = resp_ids
            for day, stage_bid, cnt in conn.execute(lead_sql, params):
                if day < 1 or day > days_in_month:
                    continue
                idx = int(day) - 1
                result["leads"][idx] += int(cnt)
                if stage_bid in _QUAL_STAGES:
                    result["qual_leads"][idx] += int(cnt)
                if stage_bid in _CANCEL_STAGES:
                    result["cancelled"][idx] += int(cnt)
                if stage_bid in _SIFATSIZ_STAGES:
                    result["sifatsiz"][idx] += int(cnt)

        # ── Deal metrics: leads+qual_leads=total deals, meetings, shartnoma
        if deal_col and source_names:
            deal_sql = _text(f"""
                SELECT
                    EXTRACT(DAY FROM d.date_create)::int AS day,
                    s.bitrix_id AS stage_bid,
                    s.is_won,
                    CASE WHEN d.currency_id = 'USD' THEN COALESCE(d.opportunity, 0) ELSE 0 END AS opp
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
                WHERE d.date_create::date BETWEEN :since AND :until
                  AND d.{deal_col} = ANY(:names)
                  AND d.category_id = 0
                  {resp_filter_deal}
            """)
            params = {"since": since, "until": until, "names": source_names}
            if resp_ids: params["resp_ids"] = resp_ids
            for day, stage_bid, is_won, opp in conn.execute(deal_sql, params):
                if day < 1 or day > days_in_month:
                    continue
                idx = int(day) - 1
                result["leads"][idx] += 1       # lidlar soni = deal count
                result["qual_leads"][idx] += 1  # maqsadli lidlar = deal count
                # Every deal in this pipeline (category_id=0) is created AT the
                # "Uchrashuv o'tkazildi" stage, so any deal that exists — regardless
                # of its current stage — already had its meeting counted once.
                result["meetings"][idx] += 1
                if stage_bid == "UC_W35V62" or is_won:
                    result["deals"][idx] += 1
                    result["deals_sum"][idx] += float(opp)

        # ── Sales metrics: won deals by uf_bp_sale_date (count) + deal_payments (sum) ──
        if deal_col and source_names:
            sales_sql = _text(f"""
                SELECT EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                  AND d.{deal_col} = ANY(:names)
                  AND d.category_id = 0
                  {resp_filter_deal}
            """)
            sales_payment_sql = _text(f"""
                SELECT day, SUM(paid) AS opp FROM (
                    SELECT EXTRACT(DAY FROM p.paid_at AT TIME ZONE 'Asia/Tashkent')::int AS day,
                           p.amount_usd AS paid
                    FROM deals d
                    JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                    JOIN deal_payments p ON p.deal_id = d.id
                    WHERE p.paid_at::date BETWEEN :since AND :until
                      AND d.{deal_col} = ANY(:names)
                      AND d.category_id = 0
                      {resp_filter_deal}
                    UNION ALL
                    SELECT EXTRACT(DAY FROM COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create) AT TIME ZONE 'Asia/Tashkent')::int AS day,
                           d.uf_paid_sum AS paid
                    FROM deals d
                    JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                    WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                      AND d.{deal_col} = ANY(:names)
                      AND d.category_id = 0
                      {resp_filter_deal}
                      AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
                      AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
                ) sub GROUP BY day
            """)
            params = {"since": since, "until": until, "names": source_names}
            if resp_ids: params["resp_ids"] = resp_ids
            for (day,) in conn.execute(sales_sql, params):
                if day is None or day < 1 or day > days_in_month:
                    continue
                result["sales_count"][int(day) - 1] += 1
            for day, opp in conn.execute(sales_payment_sql, params):
                if day is None or day < 1 or day > days_in_month:
                    continue
                result["sales_sum"][int(day) - 1] += float(opp)

    int_keys = {"leads", "qual_leads", "meetings", "deals", "sales_count", "cancelled", "sifatsiz"}
    for k in int_keys:
        result[k] = [int(v) for v in result[k]]

    return {"month": month, "year": year, "section_id": section_id, "data": result}


@app.get("/api/marketing/kunlik-jami-stats")
def api_marketing_kunlik_jami_stats(month: str, year: int, responsible_id: str = ""):
    """Overall monthly totals for ALL CRM sources — used for Jami tab FAKT column."""
    import calendar as _cal
    MONTH_MAP = {
        "yanvar": 1, "fevral": 2, "mart": 3, "aprel": 4,
        "may": 5, "iyun": 6, "iyul": 7, "avgust": 8,
        "sentabr": 9, "oktabr": 10, "noyabr": 11, "dekabr": 12,
    }
    m = MONTH_MAP.get(month.lower(), 6)
    since = date(year, m, 1)
    last_day = _cal.monthrange(year, m)[1]
    until = date(year, m, last_day)

    resp_ids = [int(x) for x in responsible_id.split(",") if x.strip().isdigit()] if responsible_id else []
    resp_lead = "AND l.responsible_id = ANY(:resp_ids)" if resp_ids else ""
    resp_deal = "AND d.responsible_id = ANY(:resp_ids)" if resp_ids else ""
    p: dict = {"since": since, "until": until}
    if resp_ids:
        p["resp_ids"] = resp_ids

    with bx_engine.connect() as conn:
        leads_row = conn.execute(text(f"""
            SELECT
                COUNT(*)                                                                    AS total_leads,
                COUNT(*) FILTER (WHERE s.bitrix_id IN (
                    'IN_PROCESS','PROCESSED','UC_1KPATX','UC_Q2U9EL','UC_KXC3ZW','UC_L28G68','CONVERTED'
                ))                                                                          AS qual_leads,
                COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','JUNK'))               AS cancelled
            FROM leads l
            LEFT JOIN stages s ON s.id = l.stage_id AND s.entity = 'lead'
            WHERE l.date_create::date BETWEEN :since AND :until
            {resp_lead}
        """), p).fetchone()

        deals_row = conn.execute(text(f"""
            SELECT
                COUNT(*)                                                                    AS total_deals,
                COALESCE(SUM(CASE WHEN d.currency_id = 'USD' THEN d.opportunity ELSE 0 END), 0) AS deals_sum
            FROM deals d
            LEFT JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
            WHERE d.date_create::date BETWEEN :since AND :until
              AND (s.bitrix_id = 'UC_W35V62' OR s.is_won = true)
            {resp_deal}
        """), p).fetchone()

        sales_row = conn.execute(text(f"""
            SELECT
                (SELECT COUNT(*) FROM deals d
                 JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                 WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                 {resp_deal})                                                               AS total_sales,
                COALESCE((
                    SELECT SUM(sub.amount) FROM (
                        SELECT p.amount_usd AS amount
                        FROM deals d
                        JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                        JOIN deal_payments p ON p.deal_id = d.id
                        WHERE p.paid_at BETWEEN :since AND :until
                        {resp_deal}
                        UNION ALL
                        SELECT d.uf_paid_sum AS amount
                        FROM deals d
                        JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal' AND s.is_won = true
                        WHERE COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                          AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
                          AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
                        {resp_deal}
                    ) sub
                ), 0)                                                                       AS sales_sum
        """), p).fetchone()

        paid_row = conn.execute(text(f"""
            SELECT COALESCE(SUM(sub.amount), 0) AS total_paid
            FROM (
                SELECT p.amount_usd AS amount
                FROM deal_payments p
                JOIN deals d ON d.id = p.deal_id
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
                WHERE NOT (s.is_final = true AND s.is_won = false)
                  AND p.paid_at BETWEEN :since AND :until
                  {resp_deal}
                UNION ALL
                SELECT d.uf_paid_sum AS amount
                FROM deals d
                JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
                WHERE d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
                  AND NOT (s.is_final = true AND s.is_won = false)
                  AND COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN :since AND :until
                  AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
                  {resp_deal}
            ) sub
        """), p).fetchone()

    return {
        "month": month,
        "year": year,
        "total_leads":   int(leads_row.total_leads  or 0),
        "qual_leads":    int(leads_row.qual_leads   or 0),
        "cancelled":     int(leads_row.cancelled    or 0),
        "total_deals":   int(deals_row.total_deals  or 0),
        "deals_sum":     float(deals_row.deals_sum  or 0),
        "total_sales":   int(sales_row.total_sales  or 0),
        "sales_sum":     float(sales_row.sales_sum  or 0),
        "total_paid":    float(paid_row.total_paid  or 0),
    }


@app.api_route("/api/v1/tolov", methods=["GET", "POST"])
def api_tolov(
    id:       Optional[str] = None,
    tolov_id: Optional[str] = None,
    sana:     Optional[str] = None,
    turi:     Optional[str] = None,
    summa:    Optional[str] = None,
):
    """
    Bitrix24 To'lov webhook — deal_payments ga INSERT + deals.uf_paid_sum yangilanadi.

    Params:
      id       — deal ID (parentId2)
      tolov_id — To'lov entity ID (takrorlanmaslik uchun)
      sana     — to'lov sanasi "02.06.2026 18:17:00"
      turi     — Karta / Hisob / Naqd
      summa    — "5000000|UZS" yoki "3913|USD"
    """
    if not id:
        raise HTTPException(status_code=400, detail="id majburiy")

    try:
        deal_id = int(id)
    except ValueError:
        raise HTTPException(status_code=400, detail="id raqam bo'lishi kerak")

    tolov_id_int = int(tolov_id) if tolov_id and tolov_id.isdigit() else None

    # Parse sana
    paid_dt = None
    if sana:
        from dateutil import parser as _dparser
        try:
            paid_dt = _dparser.parse(sana.replace("+", " "), dayfirst=True)
        except Exception:
            pass

    # Parse summa
    paid_usd = None
    if summa:
        try:
            parts = str(summa).strip().split("|")
            raw_amount = float(parts[0].replace(" ", "").replace(",", "."))
            currency = parts[1].strip().upper() if len(parts) > 1 else "UZS"
            UZS_RATE = 12100
            paid_usd = round(raw_amount, 2) if currency == "USD" else round(raw_amount / UZS_RATE, 2)
        except Exception:
            pass

    if not paid_dt or paid_usd is None:
        return {"ok": True, "updated": False, "reason": "sana yoki summa yo'q"}

    with bx_engine.connect() as conn:
        # 1. deal_payments ga upsert
        conn.execute(text("""
            INSERT INTO deal_payments (deal_id, tolov_id, paid_at, amount_usd, turi)
            VALUES (:deal_id, :tolov_id, :paid_at, :amount_usd, :turi)
            ON CONFLICT (tolov_id) DO UPDATE SET
              paid_at    = EXCLUDED.paid_at,
              amount_usd = EXCLUDED.amount_usd,
              turi       = EXCLUDED.turi
        """), {
            "deal_id":    deal_id,
            "tolov_id":   tolov_id_int,
            "paid_at":    paid_dt.date(),
            "amount_usd": paid_usd,
            "turi":       turi,
        })

        # 2. deals.uf_paid_sum = barcha to'lovlar yig'indisi
        conn.execute(text("""
            UPDATE deals SET uf_paid_sum = (
              SELECT COALESCE(SUM(amount_usd), 0) FROM deal_payments WHERE deal_id = :deal_id
            )
            WHERE id = :deal_id
        """), {"deal_id": deal_id})

        # 3. deals.uf_bp_sale_date = eng birinchi to'lov sanasi
        conn.execute(text("""
            UPDATE deals SET uf_bp_sale_date = (
              SELECT MIN(paid_at) FROM deal_payments WHERE deal_id = :deal_id
            )
            WHERE id = :deal_id
        """), {"deal_id": deal_id})

        conn.commit()

    _log.info("[tolov] deal=%s tolov_id=%s sana=%s turi=%s summa_usd=%s", deal_id, tolov_id_int, paid_dt, turi, paid_usd)
    return {"ok": True, "deal_id": deal_id, "paid_usd": paid_usd, "paid_at": str(paid_dt.date())}


@app.api_route("/install", methods=["GET", "POST", "HEAD"], response_class=HTMLResponse)
async def bitrix_install(_request: Request):
    """Bitrix24 calls this during app installation. Must respond with BX24.installFinish()."""
    return HTMLResponse(content=(
        "<!DOCTYPE html><html><head>"
        '<script src="https://api.bitrix24.com/api/v1/"></script>'
        "<script>BX24.init(function(){ BX24.installFinish(); });</script>"
        "</head><body></body></html>"
    ))


@app.post("/api/bitrix/handler", response_class=HTMLResponse)
async def bitrix_iframe_handler(request: Request):
    """Bitrix24 POSTs here when the app is opened from a CRM Lead/Deal card.
    Reads PLACEMENT_OPTIONS, fetches the client name, injects it into index.html."""
    form = await request.form()
    placement = str(form.get("PLACEMENT") or "")
    placement_options_raw = str(form.get("PLACEMENT_OPTIONS") or "")

    client_name = None
    try:
        opts = json.loads(placement_options_raw) if placement_options_raw else {}
        entity_id = opts.get("ID")
        if entity_id:
            if "LEAD" in placement:
                lead = bitrix.get_lead_details(int(entity_id))
                if lead:
                    parts = [lead.get("NAME") or "", lead.get("LAST_NAME") or ""]
                    client_name = " ".join(p for p in parts if p) or None
            elif "DEAL" in placement:
                deal = bitrix.get_deal_details(int(entity_id))
                if deal and deal.get("CONTACT_ID"):
                    contact = bitrix.get_contact_details(int(deal["CONTACT_ID"]))
                    if contact:
                        parts = [contact.get("NAME") or "", contact.get("LAST_NAME") or ""]
                        client_name = " ".join(p for p in parts if p) or None
    except Exception:
        pass  # Return app without pre-fill rather than erroring

    dist_index = Path("/var/www/mountain/frontend/app/dist/index.html")
    html = dist_index.read_text(encoding="utf-8")
    # Inject BX24 SDK + context + route before React mounts.
    # The SDK script must come first so BX24 is defined when the app bundle runs.
    script = (
        f'<script src="https://api.bitrix24.com/api/v1/"></script>'
        f'<script>'
        f'window.__BX_CLIENT__={json.dumps({"clientName": client_name})};'
        f'history.replaceState(null,"","/lidlar");'
        f'BX24.init(function(){{}});'
        f'</script>'
    )
    html = html.replace("</head>", f"{script}</head>", 1)
    return HTMLResponse(content=html)


if __name__ == "__main__":
    host = os.getenv("SERVER_IP", "127.0.0.1")
    uvicorn.run(app, host=host, port=8000)

