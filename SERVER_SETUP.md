# Mountain — server konfiguratsiyasi

Bu hujjat Mountain ilovasining production deploy'ini tushuntiradi.

## Server tafsilotlari

- **Provider:** Contabo VPS
- **IP:** `207.180.198.41`
- **Hostname:** `vmi3222597.contaboserver.net`
- **OS:** Ubuntu 22.04 LTS
- **Resources:** 4 CPU · 7.8 GB RAM · 146 GB disk

## SSH

- **Port:** 22 (default)
- **User:** `root`
- **Auth:** ed25519 key only (paroldan foydalanish blocked emas, lekin amaliyotda kalit ishlatiladi)
- **Local config:** `~/.ssh/config` da `Host mountain` alias mavjud — `ssh mountain` orqali ulanish

```
Host mountain
    HostName 207.180.198.41
    User root
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

## Tuzilish (server)

```
/var/www/mountain/                   git clone
├── backend/
│   ├── app/...                      FastAPI app
│   ├── venv/                        Python 3.10 venv (yaratiladi server'da)
│   ├── .env                         tokens — git'ga kirmaydi, qo'lda nusxalanadi
│   └── requirements.txt
└── frontend/
    └── app/                         Vite + React + TS
        ├── dist/                    nginx bu papkani uzatadi
        ├── package.json
        └── ...
```

## Servislar

| Servis | Port | Manzil | Boshqarish |
|---|---|---|---|
| **mountain** (FastAPI) | 8001 | localhost only | `systemctl {start,stop,restart,status} mountain` |
| **bitrix-sync** (Node.js) | 3001 | localhost only | `systemctl {start,stop,restart,status} bitrix-sync` |
| **nginx** | 80 | public | `systemctl reload nginx` |
| **fail2ban** | — | — | `fail2ban-client status` |

`bitrix-sync.service` unit fayli `/etc/systemd/system/bitrix-sync.service`'da (nusxasi: `bitrix-sync/bitrix-sync.service`).

Webhook URL'lar (Bitrix24 panelida ro'yxatdan o'tkaziladi):
- `http://<server-ip>/webhook/lead/created`
- `http://<server-ip>/webhook/lead/updated`
- `http://<server-ip>/webhook/deal/created`
- `http://<server-ip>/webhook/deal/updated`

`mountain.service` unit fayli `/etc/systemd/system/mountain.service`'da:

```ini
[Unit]
Description=Mountain FastAPI backend (uvicorn)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/mountain/backend
EnvironmentFile=/var/www/mountain/backend/.env
ExecStart=/var/www/mountain/backend/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 --workers 2
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Nginx

Site config: `/etc/nginx/sites-available/mountain`, `/etc/nginx/sites-enabled/mountain` orqali ulangan.

- `/api/*` → `http://127.0.0.1:8001`
- Boshqa hammasi → `dist/index.html` (SPA fallback)
- Cache: `/assets/*` 1 yil immutable
- Security headers: X-Frame-Options, X-Content-Type-Options, Referrer-Policy

## Firewall (UFW)

| Port | Maqsad |
|---|---|
| 22 | SSH |
| 80 | HTTP |
| 443 | HTTPS (kelajakda TLS uchun) |
| 5000 | Boshqa proyektning bot API'si (`/root/mountain` Telegram bot) |
| 3128 | Squid proxy |

Boshqa hamma tashqi portlar bloklangan. Holat: `ufw status numbered`.

## Fail2Ban

Jails: `sshd`, `nginx-http-auth`, `nginx-bad-request`, `nginx-botsearch`. Default bantime 1 soat, maxretry 5 (sshd 4).

```
fail2ban-client status              # umumiy holat
fail2ban-client status sshd         # SSH bloklari
fail2ban-client unban <IP>          # IP'ni qo'lda bloklash bekor qilish
```

## Deployga kirish — `deploy.sh`

```bash
./deploy.sh                         # backend + frontend
./deploy.sh --backend-only          # faqat backend
./deploy.sh --frontend-only         # faqat frontend
./deploy.sh --skip-push             # faqat server pull
./deploy.sh "fix: filter bug"       # custom commit message
```

Skript:
1. `ssh mountain` ulanish testi
2. `git push origin main`
3. Server'da `git pull` → backend deps → `systemctl restart mountain`
4. Frontend: `npm ci` → `npm run build` → `systemctl reload nginx`
5. Health check: systemd active, HTTP 200, `/api/users` to'g'ri javob

## Boshqa muhim eslatmalar

### `/root/mountain/` — bu BOSHQA proyekt
Server'da `/root/mountain/` papkasi mavjud. Bu **Telegram bot** (port 5000). Mountain dashboard'imizga aloqasi yo'q. Tegmaslik kerak.

### Squid proxy (3128)
Server'da Squid ishlamoqda. Boshqa proyektlar uchun. UFW'da ochiq qoldirilgan.

### TLS
Domain hali yo'q. HTTPS yo'q. Domain qo'shilganda:

```bash
ssh mountain
certbot --nginx -d <domain.com>
```

certbot allaqachon o'rnatilgan.

### GitHub deploy key
Server `id_ed25519_github` kalit bilan repo'ga kiradi. Public key `mountain-server` nomi bilan repo'ning Deploy Keys ro'yxatida (`gh repo view JaysonKhan/mountain --json deployKeys`).

### Logs

```bash
ssh mountain "journalctl -u mountain -f"          # backend logs (live)
ssh mountain "journalctl -u mountain -n 100"      # backend last 100 lines
ssh mountain "tail -f /var/log/nginx/access.log"  # nginx access
ssh mountain "tail -f /var/log/nginx/error.log"   # nginx errors
ssh mountain "fail2ban-client status sshd"        # SSH ban list
```

## bitrix-sync birinchi marta sozlash (bir marta bajariladi)

```bash
# 1. Server'da .env fayli yaratish
ssh mountain
cat > /var/www/mountain/bitrix-sync/.env << 'EOF'
DATABASE_URL=postgresql://mountain:mountain123@localhost:5432/mountain_db
BITRIX_WEBHOOK_URL=https://your-domain.bitrix24.com/rest/1/your-token
PORT=3001

# OnlinePBX — Call statistikasi manbasi (Bitrix telephony o'rniga)
# API key: OnlinePBX panel → Настройки → API (real qiymatlar faqat server .env'da!)
ONPBX_DOMAIN=your-pbx.onpbx.ru
ONPBX_API_KEY=your-onlinepbx-api-key
CALL_SYNC_INTERVAL_MIN=5
CALL_SYNC_LOOKBACK_HOURS=3
CALL_SYNC_BACKFILL_DAYS=45
EOF

# 2. PostgreSQL DB va foydalanuvchi yaratish (agar yo'q bo'lsa)
sudo -u postgres psql -c "CREATE USER mountain WITH PASSWORD 'mountain123';"
sudo -u postgres psql -c "CREATE DATABASE mountain_db OWNER mountain;"

# 3. Schema apply qilish
psql $DATABASE_URL -f /var/www/mountain/bitrix-sync/src/db/schema.sql

# 4. systemd service o'rnatish
cp /var/www/mountain/bitrix-sync/bitrix-sync.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable bitrix-sync
systemctl start bitrix-sync

# 5. Dastlabki sync (barcha leads/deals/users import)
cd /var/www/mountain/bitrix-sync && node src/sync/initialSync.js
```

## Birinchi marta deploy (allaqachon bajarilgan)

Quyidagi qadamlar **birinchi setup uchun** bajarilgan, kelajakda kerak emas — `./deploy.sh` yetarli.

1. Mac'da: `gh auth login` + `~/.ssh/config`'da `Host mountain` alias
2. Server'da: `apt install nginx ufw fail2ban certbot python3-certbot-nginx python3-venv git build-essential nodejs`
3. Server'da `~/.ssh/id_ed25519_github` deploy key + GitHub repo Deploy Keys ro'yxatiga qo'shish
4. `cd /var/www && git clone git@github.com:JaysonKhan/mountain.git`
5. Backend: `python3 -m venv backend/venv && backend/venv/bin/pip install -r backend/requirements.txt`
6. `.env` fayli Mac'dan `scp` qilingan
7. Frontend: `cd frontend/app && npm ci && npm run build`
8. `mountain.service` systemd unit yaratildi va enable qilindi
9. nginx site config qo'shildi va reload qilindi
10. UFW + Fail2Ban yoqildi
