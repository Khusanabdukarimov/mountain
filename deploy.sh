#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Mountain Deploy Script — lokal build + rsync to 207.180.198.41
# ══════════════════════════════════════════════════════════════════════════════
# Usage:
#   ./deploy.sh                   — full deploy (backend + frontend)
#   ./deploy.sh "commit message"  — custom commit message
#   ./deploy.sh --backend-only    — sync backend + restart service only
#   ./deploy.sh --frontend-only   — build frontend + rsync dist only
#   ./deploy.sh --skip-push       — skip git commit/push
# ══════════════════════════════════════════════════════════════════════════════

set -e

# ─── Config ───────────────────────────────────────────────────────────────────
SERVER="mountain"           # ~/.ssh/config → 207.180.198.41
PUBLIC_IP="207.180.198.41"

LOCAL_ROOT="$(cd "$(dirname "$0")" && pwd)"
LOCAL_FRONTEND="$LOCAL_ROOT/frontend/app"
LOCAL_BACKEND="$LOCAL_ROOT/backend"
LOCAL_SYNC="$LOCAL_ROOT/bitrix-sync"

REMOTE_ROOT="/var/www/mountain"
REMOTE_BACKEND="$REMOTE_ROOT/backend"
REMOTE_DIST="$REMOTE_ROOT/frontend/app/dist"
REMOTE_SYNC="$REMOTE_ROOT/bitrix-sync"
VENV_PIP="$REMOTE_BACKEND/venv/bin/pip"

SERVICE="mountain"
SYNC_SERVICE="bitrix-sync"

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
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}${BOLD}✔${RESET} $*"; }
warn() { echo -e "${YELLOW}${BOLD}⚠${RESET} $*"; }
err()  { echo -e "${RED}${BOLD}✖${RESET} $*"; exit 1; }
info() { echo -e "${CYAN}${BOLD}ℹ${RESET} $*"; }
remote() { ssh "$SERVER" "$@"; }

START_TIME=$(date +%s)

# ─── Banner ───────────────────────────────────────────────────────────────────
echo
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}🏔  Mountain Deploy${RESET}  ${DIM}→ ${PUBLIC_IP}${RESET}"
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
ok "  SSH → $PUBLIC_IP OK"
echo

# ─── Git commit + push ────────────────────────────────────────────────────────
if ! $SKIP_PUSH; then
    info "Git push..."
    git add -A
    if git diff --cached --quiet; then
        warn "  No changes to commit — pushing anyway"
    else
        git commit -m "$MSG"
        ok "  Committed: ${DIM}$MSG${RESET}"
    fi
    git push origin main
    ok "  Pushed to origin/main"
    echo
fi

ALL_OK=true

# ══════════════════════════════════════════════════════════════════════════════
# Backend — rsync Python files + restart
# ══════════════════════════════════════════════════════════════════════════════
if $DEPLOY_BACKEND; then
    echo -e "${CYAN}${BOLD}── backend ──${RESET}"

    info "  Syncing backend files..."
    rsync -az --delete \
        --exclude='__pycache__' --exclude='*.pyc' --exclude='.env' \
        --exclude='venv/' --exclude='*.log' \
        "$LOCAL_BACKEND/" "$SERVER:$REMOTE_BACKEND/"
    ok "  Backend files synced"

    info "  Python dependencies..."
    remote "$VENV_PIP install -q -r $REMOTE_BACKEND/requirements.txt"
    ok "  Dependencies installed"

    info "  Restarting $SERVICE..."
    remote "systemctl restart $SERVICE"
    ok "  $SERVICE restarted"

    info "  Syncing bitrix-sync files..."
    rsync -az --delete \
        --exclude='node_modules/' --exclude='.env' --exclude='*.log' \
        "$LOCAL_SYNC/" "$SERVER:$REMOTE_SYNC/"
    ok "  bitrix-sync files synced"

    info "  Node.js dependencies..."
    remote "cd $REMOTE_SYNC && npm ci --silent"
    ok "  npm ci done"

    info "  Restarting $SYNC_SERVICE..."
    remote "systemctl restart $SYNC_SERVICE 2>/dev/null || true"
    ok "  $SYNC_SERVICE restarted"
    echo
fi

# ══════════════════════════════════════════════════════════════════════════════
# Frontend — lokal build + rsync dist
# ══════════════════════════════════════════════════════════════════════════════
if $DEPLOY_FRONTEND; then
    echo -e "${CYAN}${BOLD}── frontend ──${RESET}"

    info "  npm ci (local)..."
    (cd "$LOCAL_FRONTEND" && npm ci --silent)
    ok "  Dependencies installed"

    info "  Vite build (local)..."
    (cd "$LOCAL_FRONTEND" && npm run build 2>&1 | tail -5)
    ok "  Build complete"

    info "  Uploading dist → server..."
    rsync -az --delete "$LOCAL_FRONTEND/dist/" "$SERVER:$REMOTE_DIST/"
    ok "  dist uploaded"

    info "  Reloading nginx..."
    remote "nginx -t && systemctl reload nginx"
    ok "  nginx reloaded"
    echo
fi

# ─── Health checks ────────────────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
info "Health checks..."
sleep 2

SVC_STATUS=$(remote "systemctl is-active $SERVICE 2>/dev/null" || echo "unknown")
if [[ "$SVC_STATUS" == "active" ]]; then
    ok "  $SERVICE: active"
else
    echo -e "${RED}${BOLD}✖${RESET}  $SERVICE: $SVC_STATUS"
    remote "journalctl -u $SERVICE -n 15 --no-pager" 2>/dev/null || true
    ALL_OK=false
fi

NGX_STATUS=$(remote "systemctl is-active nginx 2>/dev/null" || echo "unknown")
if [[ "$NGX_STATUS" == "active" ]]; then
    ok "  nginx: active"
else
    echo -e "${RED}${BOLD}✖${RESET}  nginx: $NGX_STATUS"
    ALL_OK=false
fi

HTTPS_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "https://${PUBLIC_IP}/" 2>/dev/null || echo "000")
if [[ "$HTTPS_CODE" =~ ^(200|301|302)$ ]]; then
    ok "  HTTPS /: ${DIM}$HTTPS_CODE${RESET}"
else
    warn "  HTTPS / returned $HTTPS_CODE"
    ALL_OK=false
fi

API_RESP=$(curl -sfk --max-time 8 "https://${PUBLIC_IP}/api/auth/status" 2>/dev/null || echo "")
if [[ -n "$API_RESP" ]]; then
    AUTH_ENABLED=$(echo "$API_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('enabled' if d.get('enabled') else 'disabled')" 2>/dev/null || echo "?")
    ok "  /api/auth/status: ${DIM}auth $AUTH_ENABLED${RESET}"
else
    warn "  /api/auth/status failed"
    ALL_OK=false
fi

# ─── Final ────────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
DURATION_STR="${DURATION}s"
[[ "$DURATION" -ge 60 ]] && DURATION_STR="$((DURATION / 60))m $((DURATION % 60))s"

echo
if $ALL_OK; then
    echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${GREEN}${BOLD}✅ Deploy successful!${RESET}  ${DIM}(${DURATION_STR})${RESET}"
    echo -e "   ${DIM}URL:${RESET} https://mountdashboard.data365verification.uz/"
    echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
else
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${RED}${BOLD}❌ Deploy had failures${RESET}"
    echo -e "${DIM}Check: ssh $SERVER \"journalctl -u $SERVICE -f\"${RESET}"
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    exit 1
fi
