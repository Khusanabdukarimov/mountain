#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Mountain Unified Deploy Script
# ══════════════════════════════════════════════════════════════════════════════
# Usage:
#   ./deploy.sh                        — git push + remote pull/build/restart (default)
#   ./deploy.sh "commit message"       — with custom commit message
#   ./deploy.sh --backend-only         — restart backend only (no frontend rebuild)
#   ./deploy.sh --frontend-only        — rebuild frontend only (no backend restart)
#   ./deploy.sh --skip-push            — skip git push (server pulls existing main)
#
# Architecture (server 207.180.198.41):
#   /var/www/mountain/        repo clone (main branch)
#   /var/www/mountain/backend mountain.service (systemd) — uvicorn 127.0.0.1:8001
#   /var/www/mountain/frontend/app/dist  served by nginx on :80
#
# Connect via:  ssh mountain
# ══════════════════════════════════════════════════════════════════════════════

set -e

# ─── Config ───────────────────────────────────────────────────────────────────
SERVER="mountain"
PUBLIC_IP="207.180.198.41"

REPO_DIR="/var/www/mountain"
BACKEND_DIR="$REPO_DIR/backend"
FRONTEND_DIR="$REPO_DIR/frontend/app"
SYNC_DIR="$REPO_DIR/bitrix-sync"
VENV_PIP="$BACKEND_DIR/venv/bin/pip"
SERVICE="mountain"
SYNC_SERVICE="bitrix-sync"
BRANCH="main"

# ─── Parse flags ──────────────────────────────────────────────────────────────
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true
SKIP_PUSH=false
MSG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend-only)  DEPLOY_FRONTEND=false; shift ;;
        --frontend-only) DEPLOY_BACKEND=false;  shift ;;
        --skip-push)     SKIP_PUSH=true;        shift ;;
        *)               MSG="$*"; break ;;
    esac
done
MSG="${MSG:-deploy update}"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}${BOLD}✔${RESET} $*"; }
warn() { echo -e "${YELLOW}${BOLD}⚠${RESET} $*"; }
err()  { echo -e "${RED}${BOLD}✖${RESET} $*"; exit 1; }
info() { echo -e "${CYAN}${BOLD}ℹ${RESET} $*"; }

remote() { ssh "$SERVER" "$@"; }

START_TIME=$(date +%s)

# ─── Banner ───────────────────────────────────────────────────────────────────
echo
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}🏔  Mountain Deploy${RESET}  ${DIM}(http://${PUBLIC_IP}/)${RESET}"
echo -e "${DIM}   $(date '+%Y-%m-%d %H:%M:%S')${RESET}"
TARGETS=""
$DEPLOY_BACKEND  && TARGETS+="backend "
$DEPLOY_FRONTEND && TARGETS+="frontend "
echo -e "${DIM}   Targets: ${TARGETS}${RESET}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo

# ─── Pre-flight ───────────────────────────────────────────────────────────────
info "Pre-flight checks..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SERVER" "echo ok" &>/dev/null; then
    err "Cannot connect to '$SERVER'. Check ~/.ssh/config."
fi
ok "  SSH connection OK"
echo

# ─── Git push ─────────────────────────────────────────────────────────────────
if ! $SKIP_PUSH; then
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
        warn "Local branch is '$CURRENT_BRANCH' (server tracks '$BRANCH')"
    fi
    info "Git push... ${DIM}(branch: $CURRENT_BRANCH)${RESET}"

    git add -A
    if git diff --cached --quiet; then
        warn "  No changes to commit — pushing anyway"
    else
        git commit -m "$MSG"
        ok "  Committed: ${DIM}$MSG${RESET}"
    fi
    git push origin "$CURRENT_BRANCH"
    ok "  Pushed to origin/$CURRENT_BRANCH"
    echo
fi

ALL_OK=true

# ─── Server pull ──────────────────────────────────────────────────────────────
info "Server git pull..."
remote "cd $REPO_DIR && git remote set-url origin git@github.com:Khusanabdukarimov/mountain.git && git fetch origin $BRANCH && git reset --hard origin/$BRANCH" \
    | tail -1
ok "  Code updated"
echo

# ══════════════════════════════════════════════════════════════════════════════
# Backend
# ══════════════════════════════════════════════════════════════════════════════
if $DEPLOY_BACKEND; then
    echo -e "${CYAN}${BOLD}── backend (FastAPI) ──${RESET}"

    info "  Python dependencies..."
    remote "$VENV_PIP install -q -r $BACKEND_DIR/requirements.txt"
    ok "  Dependencies installed"

    info "  Restarting $SERVICE.service..."
    remote "systemctl daemon-reload && systemctl restart $SERVICE"
    ok "  $SERVICE restarted"

    info "  Node.js dependencies (bitrix-sync)..."
    remote "cd $SYNC_DIR && npm ci --silent 2>&1 | tail -1"
    ok "  bitrix-sync dependencies installed"

    info "  Restarting $SYNC_SERVICE.service..."
    remote "systemctl daemon-reload && systemctl restart $SYNC_SERVICE 2>/dev/null || true"
    ok "  $SYNC_SERVICE restarted"
    echo
fi

# ══════════════════════════════════════════════════════════════════════════════
# Frontend
# ══════════════════════════════════════════════════════════════════════════════
if $DEPLOY_FRONTEND; then
    echo -e "${CYAN}${BOLD}── frontend (Vite + React) ──${RESET}"

    info "  npm ci..."
    remote "cd $FRONTEND_DIR && npm ci --silent" 2>&1 | tail -1
    ok "  Dependencies installed"

    info "  Vite build..."
    remote "cd $FRONTEND_DIR && npm run build 2>&1 | tail -5"
    ok "  Build complete"

    info "  Reloading nginx..."
    remote "nginx -t && systemctl reload nginx"
    ok "  nginx reloaded"
    echo
fi

# ─── Health checks ────────────────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
info "Health checks..."
sleep 2

# systemd service status
SVC_STATUS=$(remote "systemctl is-active $SERVICE 2>/dev/null" || echo "unknown")
if [[ "$SVC_STATUS" == "active" ]]; then
    ok "  $SERVICE: active"
else
    echo -e "${RED}${BOLD}✖${RESET}  $SERVICE: $SVC_STATUS"
    remote "journalctl -u $SERVICE -n 15 --no-pager" 2>/dev/null || true
    ALL_OK=false
fi

# nginx status
NGX_STATUS=$(remote "systemctl is-active nginx 2>/dev/null" || echo "unknown")
if [[ "$NGX_STATUS" == "active" ]]; then
    ok "  nginx: active"
else
    echo -e "${RED}${BOLD}✖${RESET}  nginx: $NGX_STATUS"
    ALL_OK=false
fi

# Public HTTP
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${PUBLIC_IP}/" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" =~ ^(200|301|302)$ ]]; then
    ok "  HTTP /: ${DIM}$HTTP_CODE${RESET}"
else
    warn "  HTTP / returned $HTTP_CODE"
    ALL_OK=false
fi

# /api/auth/status endpoint (public, works with auth enabled)
API_RESP=$(curl -sf --max-time 8 "http://${PUBLIC_IP}/api/auth/status" 2>/dev/null || echo "")
if [[ -n "$API_RESP" ]]; then
    AUTH_ENABLED=$(echo "$API_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('enabled' if d.get('enabled') else 'disabled')" 2>/dev/null || echo "?")
    ok "  /api/auth/status: ${DIM}auth $AUTH_ENABLED${RESET}"
else
    warn "  /api/auth/status failed"
    ALL_OK=false
fi

# ─── Final status ─────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
DURATION_STR="${DURATION}s"
[[ "$DURATION" -ge 60 ]] && DURATION_STR="$((DURATION / 60))m $((DURATION % 60))s"

echo
if $ALL_OK; then
    echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${GREEN}${BOLD}✅ Deploy successful!${RESET}  ${DIM}(${DURATION_STR})${RESET}"
    echo -e "   ${DIM}URL:${RESET}     http://${PUBLIC_IP}/"
    echo -e "   ${DIM}Service:${RESET} $SERVICE @ $REPO_DIR"
    echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
else
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${RED}${BOLD}❌ Deploy had failures${RESET}"
    echo -e "${DIM}Check: ssh $SERVER \"journalctl -u $SERVICE -f\"${RESET}"
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    exit 1
fi

