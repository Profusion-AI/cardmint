# DigitalOcean Verified SSH Access
**CardMint Production Environment**
**Created:** November 10, 2025
**Last Verified:** November 10, 2025 (Phase 2J - Landing Page & Basic Auth)
**Document Version:** 4.0

---

## Executive Summary

This document establishes the verified SSH connection between the **Fedora 42 development workstation** and the **Fedora 42 Cloud Edition production droplet** hosting CardMint's e-commerce infrastructure.

**Separation of Concerns:**
- **Development Environment:** Fedora 42 (`kyle@fedora` @ 10.0.24.97)
- **Production Environment:** Fedora 42 Cloud Edition (`cardmint-shop-prod` @ 157.245.213.233)

This separation ensures development tooling (LM Studio, CardMint backend, frontend) remains isolated from the public-facing EverShop e-commerce platform.

---

## Production Droplet Details

### Infrastructure
- **Provider:** DigitalOcean
- **Droplet ID:** `529350804`
- **Droplet Name:** `cardmint-shop-prod`
- **Plan:** Basic - 1 vCPU, 2GB RAM, 70GB SSD ($16/month)
- **Region:** NYC3 (New York City, Datacenter 3)
- **Backups:** Enabled (+$2.40/month, weekly snapshots, 4-week retention)
- **Monitoring:** Enabled (CPU, RAM, Disk alerts)

### Network
- **IPv4:** `157.245.213.233`
- **IPv6:** `2604:a880:800:14:0:1:f8c7:7000`
- **Domain:** `cardmintshop.com` ✅ **DNS configured and propagating**
- **Hostname:** `cardmint-shop-prod`
- **Nameservers:** ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com

### Operating System
- **Distribution:** Fedora 42 Cloud Edition x64
- **Kernel:** 6.14.0-63.fc42.x86_64
- **Architecture:** x86_64

---

## SSH Access Configuration

### SSH Key Details

**Private Key Path:** `~/.ssh/cardmint_droplet`
**Public Key Path:** `~/.ssh/cardmint_droplet.pub`

**Public Key (safe to share):**
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEaBeRhFuqUPiyByvUpgiExmo9Vbm6/2LbB3RHLIoWpW kyle@cardmint-droplet
```

**Fingerprints:**
- **MD5:** `15:75:0f:61:9a:b6:d6:e3:e4:f8:03:b6:1f:e8:49:a7`
- **SHA256:** `PTx6jihoJbCyqZFinxXYnasiuuTK409Opx1f6+XW0TA`

**Key Type:** ED25519 (256-bit, modern elliptic curve)

### Current Access Credentials

**User:** `cardmint` (non-root with sudo privileges)
**Authentication:** SSH key only (password authentication disabled)
**Root SSH:** Disabled (PermitRootLogin no)

**✅ Security Hardening Complete:** Phase 2H security measures implemented on November 10, 2025.

---

## Verified Connection Commands

### From Fedora Development Workstation

#### Standard Connection
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233
```

#### Using Domain (after DNS propagation)
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@cardmintshop.com
```

#### Connection with Command Execution
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'command_here'
```

#### Commands Requiring Root Privileges
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo command_here'
```

#### Example: System Health Check
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'hostname; uptime -p; df -h /; free -h'
```

### Connection Verification

**Test connection and gather system info:**
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
echo "✅ SSH Connection Verified"
echo "Hostname: $(hostname)"
source /etc/os-release
echo "OS: ${PRETTY_NAME}"
echo "Kernel: $(uname -r)"
echo "Uptime: $(uptime -p)"
echo "IPv4: $(curl -s ifconfig.me)"
echo "Disk Usage: $(df -h / | tail -1 | awk '{print $5}')"
echo "Memory Usage: $(free -h | grep Mem | awk '{print $3"/"$2}')"
EOF
```

---

## SSH Key Installation History

### Method Used: DigitalOcean API (November 10, 2025)

The SSH key was configured properly during droplet creation via the DigitalOcean API. After an initial failed attempt with the web console, the droplet was destroyed and recreated with the SSH key ID (`51859571`) included in the API payload.

**Steps Taken:**
1. Generated SSH key pair on Fedora workstation (`ssh-keygen -t ed25519`)
2. Added public key to DigitalOcean account (web dashboard)
3. Destroyed problematic droplet via API (ID: `529332978`)
4. Created new droplet via API with proper SSH key configuration
5. Verified SSH access immediately after provisioning
6. Cloud-init automatically handled system hardening during first boot

**Cloud-Init Automation:**
- Firewalld configuration (SSH, HTTP, HTTPS)
- Docker installation
- Fail2Ban setup
- dnf-automatic (auto-updates)
- 2GB swap (zram)
- SELinux boolean configuration

---

## Security Configuration

### Current State (Post-Security Hardening - November 10, 2025)
- ✅ SSH key authentication enabled (ED25519)
- ✅ Private key secured on Fedora workstation (`~/.ssh/cardmint_droplet`, permissions 600)
- ✅ Password authentication disabled
- ✅ Root SSH login **DISABLED** (`PermitRootLogin no`)
- ✅ Non-root `cardmint` user created with sudo (NOPASSWD)
- ✅ Firewalld configured (SSH, HTTP, HTTPS, DHCPv6-client, mDNS)
- ✅ Fail2Ban active (brute-force protection)
- ✅ Automatic security updates enabled (dnf-automatic)
- ✅ Docker installed and running (v28.5.2)
- ✅ SELinux enforcing with `httpd_can_network_connect` enabled
- ✅ 1.9GB swap configured (zram)
- ✅ systemd-binfmt.service masked (non-critical, not needed for web server)

### Security Hardening Completed (Phase 2H)
- ✅ Create non-root `cardmint` user with sudo privileges
- ✅ Copy SSH key to `cardmint` user
- ✅ Disable root SSH login (`PermitRootLogin no` in `/etc/ssh/sshd_config`)
- ✅ Configure firewalld (allow SSH, HTTP, HTTPS only)
- ✅ Install and configure Fail2Ban (brute-force protection)
- ✅ Enable automatic security updates (dnf-automatic.timer)

---

## EverShop E-Commerce Platform

### Installation Details (Phase 2E - November 10, 2025)

**Version:** EverShop v2.0.1 (latest stable)
**Installation Path:** `/opt/cardmint`
**Database:** PostgreSQL 16
**Container Orchestration:** Docker Compose

**Services:**
- `cardmint-app-1`: EverShop application (port 3000 internally)
- `cardmint-database-1`: PostgreSQL 16 (port 5432 internally)

**Environment Configuration:**
- Location: `/opt/cardmint/.env` (permissions: 600)
- Node Environment: `production`
- Admin Email: `admin@cardmintshop.com`
- Admin Password: `[REDACTED - See .local/credentials/DO-verified-access.md]`

**Credentials Generated:**
```bash
# Database
DB_USER=evershop
DB_PASSWORD=[REDACTED - See server /opt/cardmint/.env]
DB_NAME=evershop

# Session Secret (64 chars)
SESSION_SECRET=[REDACTED - See server /opt/cardmint/.env]
```

**Docker Management:**
```bash
# View logs
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'docker compose -f /opt/cardmint/docker-compose.yml logs --tail=50'

# Restart services
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'docker compose -f /opt/cardmint/docker-compose.yml restart'

# Check status
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'docker compose -f /opt/cardmint/docker-compose.yml ps'
```

---

## Nginx Reverse Proxy & SSL Configuration

### Nginx Setup (Phase 2F - November 10, 2025, Updated Phase 2J - November 10, 2025)

**Version:** nginx/1.28.0
**Configuration:** `/etc/nginx/conf.d/cardmint.conf`
**Access Logs:** `/var/log/nginx/cardmint-access.log`
**Error Logs:** `/var/log/nginx/cardmint-error.log`

**Landing Page (Phase 2J):**
- **Static Landing:** `/var/www/cardmint-landing/` (public "Coming Soon" page)
- **Purpose:** Professional public presence while preparing product catalog
- **Design:** Modern gradient (purple/blue), responsive, mobile-friendly

**Proxy Configuration:**
- Port 3000 (EverShop) → Port 80/443 (public HTTP/HTTPS)
- **Public Routes:** Landing page at root (`/`)
- **Protected Routes:** Admin panel at `/admin/` (HTTP Basic Auth required)
- **Asset Routes:** `/assets/` proxied to EverShop (static assets)
- Client max upload: 10MB (for product images)
- Proxy timeouts: 60 seconds (connect, send, read)
- WebSocket support enabled (Upgrade headers via connection_upgrade map)

**Basic Authentication (Phase 2J):**
- **Protected Path:** `/admin/` and all sub-routes
- **Auth File:** `/etc/nginx/.htpasswd_cardmint`
- **Encryption:** Bcrypt (high security)
- **Username:** `admin`
- **Password:** `[REDACTED - See .local/credentials/DO-verified-access.md]`

**Security Headers:**
```nginx
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

**Current Route/GraphQL Posture (Dec 2, 2025):**
- `/` → static landing (Coming Soon); `/home/` → CardMint SPA build at `/var/www/cardmint-web/`.
- `/api/graphql` → EverShop GraphQL reads (public). Prod introspection/playground disabled; stage only. See `docs/security-posture.md` for rate-limit/logging policy (anon vs auth buckets, 100 rpm authenticated tolerance).
- `/api/*` and `/admin/*` → EverShop API/Admin behind Basic Auth.
- CORS/CSP tightening and nginx rate limits for `/api/graphql` tracked in `docs/security-posture.md` (pending rollout).

**HTTP Method Support:**
- HEAD requests: Served by static file handler for landing page
- GET/POST/PUT/DELETE: Proxied to EverShop for admin routes
- ACME challenge: Served from `/var/lib/letsencrypt` for certificate renewal

### SSL Certificate (Phase 2G - November 10, 2025)

**Certificate Authority:** Let's Encrypt
**Certificate Type:** ECDSA (modern, efficient)
**Domains Covered:** `cardmintshop.com`, `www.cardmintshop.com`
**Issued:** November 10, 2025 18:45:42 GMT
**Expires:** February 8, 2026 18:45:41 GMT (90 days)
**Auto-Renewal:** Enabled (certbot.timer)

**Certificate Paths:**
- Full Chain: `/etc/letsencrypt/live/cardmintshop.com/fullchain.pem`
- Private Key: `/etc/letsencrypt/live/cardmintshop.com/privkey.pem`
- DH Params: `/etc/letsencrypt/ssl-dhparams.pem`

**SSL Configuration (Mozilla Recommended):**
- **Protocols:** TLSv1.2, TLSv1.3 only
- **Ciphers:** ECDHE-ECDSA-AES-GCM, ECDHE-RSA-AES-GCM, ChaCha20-Poly1305
- **Session Tickets:** Disabled (enhanced security)
- **Session Cache:** 10MB shared cache, 1440min timeout
- **HSTS:** Enabled (1 year max-age, includeSubDomains, preload-ready)
- **SSL Labs Grade:** A+ (verified requirements met)

**HTTP to HTTPS Redirect:** ✅ Automatic (301 permanent redirect)

**Certificate Management:**
```bash
# Check certificate details
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo certbot certificates'

# Force renewal (testing)
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo certbot renew --dry-run'

# Manual renewal (if needed)
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo certbot renew'
```

---

## Public Access URLs

### Production Landing Page (Phase 2J - November 10, 2025)
- **Public URL:** https://cardmintshop.com ✅
- **Content:** "Coming Soon" landing page (purple gradient, CardMint branding)
- **Status:** Live and publicly accessible
- **Purpose:** Professional placeholder while preparing product catalog and theming

### Admin Panel (Protected by Basic Auth - Phase 2J)
- **URL:** https://cardmintshop.com/admin
- **Basic Auth Username:** `admin`
- **Basic Auth Password:** `[REDACTED - See .local/credentials/]`
- **EverShop Login Email:** admin@cardmintshop.com
- **EverShop Login Password:** `[REDACTED - See .local/credentials/]`

**Admin Access Flow:**
1. Browser prompts for Basic Auth credentials (username: `admin`, password: [REDACTED])
2. After Basic Auth, EverShop login page loads
3. Login with EverShop credentials (admin@cardmintshop.com / [REDACTED])

### Access Patterns
- **Public Landing:** No authentication, static HTML served by Nginx
- **Admin Routes:** HTTP Basic Auth → EverShop login (two-layer security)
- **Direct IP Access:** Not configured (use domain name only)
- **HTTP Traffic:** Automatic 301 redirect to HTTPS

### Testing Commands
```bash
# Test public landing page (200 OK, HTML returned)
curl -Is --resolve cardmintshop.com:443:157.245.213.233 https://cardmintshop.com | grep -E '(HTTP|Strict-Transport|Content-Type)'

# View landing page title
curl -s --resolve cardmintshop.com:443:157.245.213.233 https://cardmintshop.com | grep -o '<title>[^<]*</title>'

# Test admin without Basic Auth (401 Unauthorized expected)
curl -Is --resolve cardmintshop.com:443:157.245.213.233 https://cardmintshop.com/admin/login | head -5

# Test admin with Basic Auth (EverShop login page expected)
# Password: See .local/credentials/DO-verified-access.md
curl -s -u admin:'[REDACTED]' --resolve cardmintshop.com:443:157.245.213.233 https://cardmintshop.com/admin/login | grep -o '<title>[^<]*</title>'

# Test security headers on landing page
curl -Is --resolve cardmintshop.com:443:157.245.213.233 https://cardmintshop.com | grep -E '(HTTP|Strict-Transport|X-Frame|X-Content|X-XSS)'

# Test www subdomain
curl -Is --resolve www.cardmintshop.com:443:157.245.213.233 https://www.cardmintshop.com | head -15

# Check HTTP → HTTPS redirect
curl -I --resolve cardmintshop.com:80:157.245.213.233 http://cardmintshop.com | grep Location

# Check SSL certificate details
echo | openssl s_client -connect 157.245.213.233:443 -servername cardmintshop.com 2>/dev/null | openssl x509 -noout -subject -issuer -dates

# SSL Labs scan (once DNS propagates globally)
# Visit: https://www.ssllabs.com/ssltest/analyze.html?d=cardmintshop.com
```

---

## Troubleshooting

### Issue: "Permission denied (publickey)"
**Cause:** SSH key not in droplet's `authorized_keys`

**Solution:**
1. Access via Recovery Console (DigitalOcean dashboard → Droplet → Recovery → Boot from Recovery ISO)
2. Mount root filesystem: `mount /dev/vda4 /mnt`
3. Add public key to `/mnt/root/.ssh/authorized_keys`
4. Set permissions: `chmod 700 /mnt/root/.ssh && chmod 600 /mnt/root/.ssh/authorized_keys`
5. Unmount and reboot: `umount /mnt && sync && reboot`

### Issue: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED"
**Cause:** Droplet was recreated or IP was previously used by different host

**Solution:**
```bash
ssh-keygen -R 157.245.213.233
ssh-keygen -R cardmintshop.com  # If using domain
```

### Issue: Connection timeout
**Verification Steps:**
1. Check droplet is powered on (DigitalOcean dashboard)
2. Verify IP address is correct: `dig +short cardmintshop.com`
3. Test basic connectivity: `ping 157.245.213.233`
4. Check firewall allows SSH: `ssh -v -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233` (verbose mode)

### Issue: "Host key verification failed"
**Cause:** Strict host key checking enabled and host key not in `known_hosts`

**Solution:**
```bash
ssh -i ~/.ssh/cardmint_droplet -o StrictHostKeyChecking=accept-new cardmint@157.245.213.233
```

---

## For Claude Code and Codex

### Automated SSH Command Template

When executing commands on the production droplet, use this template:

```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'COMMAND_HERE'
```

**For commands requiring root privileges:**
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo COMMAND_HERE'
```

**Example Usage:**
```bash
# Check Docker status
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo systemctl status docker'

# View EverShop logs
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'docker compose -f /opt/cardmint/docker-compose.yml logs --tail=50 evershop'

# Check disk space
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'df -h'

# Check firewall rules
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo firewall-cmd --list-services'
```

### Multi-Line Command Execution

For complex multi-step operations, use heredoc:

```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
#!/bin/bash
set -e  # Exit on error

# Your commands here
echo "Step 1: Update package list"
sudo dnf check-update

echo "Step 2: Install package"
sudo dnf install -y package-name

echo "✅ Operation complete"
EOF
```

### Safety Guidelines

**Before executing commands:**
1. Verify you're targeting the correct environment (production vs development)
2. Use `set -e` in scripts to exit on first error
3. Test destructive operations on development environment first
4. Create manual snapshot before risky changes (DigitalOcean dashboard → Droplets → Snapshots)

**Separation of Concerns:**
- **Local Fedora commands:** Run directly via Bash tool
- **Production Fedora commands:** Prefix with SSH connection
- **Package management:** Use `dnf` (not `apt`) - this is Fedora 42, not Ubuntu

---

## Access Audit Log

| Date | User | Action | Method | Notes |
|------|------|--------|--------|-------|
| 2025-11-10 | Kyle | Initial SSH key generation | `ssh-keygen -t ed25519` | Generated on Fedora workstation |
| 2025-11-10 | Kyle | SSH key uploaded to DigitalOcean | Web dashboard | Added as "cardmint-droplet-prod" (ID: 51859571) |
| 2025-11-10 | Claude | First droplet created | DigitalOcean API | Fedora 42, ID: 529332978, SSH key issues |
| 2025-11-10 | Claude | Droplet destroyed | DigitalOcean API | Unable to resolve SSH auth, recreated properly |
| 2025-11-10 | Claude | Droplet recreated with SSH key | DigitalOcean API | ID: 529350804, cloud-init automation enabled |
| 2025-11-10 | Claude | SSH connection verified | Command line | Successful root access via key |
| 2025-11-10 | Claude | Cloud-init hardening completed | Automated | Docker, firewalld, fail2ban, dnf-automatic |
| 2025-11-10 | Claude | cardmint user created | SSH command | Non-root with sudo, docker group |
| 2025-11-10 | Claude | Root SSH login disabled | SSH command | PermitRootLogin no, security hardened |
| 2025-11-10 | Kyle | DNS nameservers configured | Namecheap dashboard | Pointed to ns1/ns2/ns3.digitalocean.com |
| 2025-11-10 | Kyle | DNS A records added | DigitalOcean dashboard | cardmintshop.com → 157.245.213.233 |
| 2025-11-10 | Claude | Git installed | dnf package manager | v2.51.1 for EverShop clone |
| 2025-11-10 | Claude | EverShop v2.0.1 cloned | Git clone | /opt/cardmint, shallow clone depth 1 |
| 2025-11-10 | Claude | Production credentials generated | OpenSSL rand | DB, admin, session secret |
| 2025-11-10 | Claude | EverShop configured | .env file creation | PostgreSQL 16, production mode |
| 2025-11-10 | Claude | Docker Compose started | docker compose up -d | EverShop + PostgreSQL containers |
| 2025-11-10 | Claude | Nginx reverse proxy configured | /etc/nginx/conf.d/cardmint.conf | Port 3000 → 80/443 |
| 2025-11-10 | Claude | SSL certificate obtained | Certbot | Let's Encrypt ECDSA cert, 90-day validity |
| 2025-11-10 | Claude | HTTPS enabled | Certbot nginx deployment | Auto HTTP→HTTPS redirect configured |
| 2025-11-10 | Claude | Documentation updated | File edit | DO-verified-access.md v3.0 with deployment details |
| 2025-11-10 | Claude | HEAD request support added | Nginx config update | Codex QA: SSL Labs compatibility |
| 2025-11-10 | Claude | HSTS header enabled | Nginx config update | Codex QA: SSL Labs A+ requirement |
| 2025-11-10 | Claude | Documentation audit | File edit | Fixed outdated IP/user references |
| 2025-11-10 | Claude | httpd-tools installed | dnf package manager | For htpasswd Basic Auth management |
| 2025-11-10 | Claude | Basic Auth password created | htpasswd command | Admin panel protection (bcrypt) |
| 2025-11-10 | Claude | Landing page created | Static HTML | /var/www/cardmint-landing/ (Coming Soon page) |
| 2025-11-10 | Claude | SELinux context set | semanage/restorecon | httpd_sys_content_t for landing page |
| 2025-11-10 | Claude | Nginx reconfigured | File edit | Landing page + Basic Auth on /admin/ |
| 2025-11-10 | Claude | Documentation updated | File edit | DO-verified-access.md v4.0 with Phase 2J details |
| 2025-12-25 | Claude | prod-2025-12-27a deployed | rsync + npm ci | Fulfillment, security hardening, 6 migrations |
| 2025-12-25 | Claude | Security tokens added | /etc/cardmint-backend.env | CARDMINT_ADMIN_API_KEY, CAPTURE_INTERNAL_KEY, DISPLAY_TOKEN |
| 2025-12-25 | Claude | Nginx route added | /etc/nginx/conf.d/cardmint.conf | /api/admin/ → port 4000 |

---

## CardMint Backend Deployment

The CardMint backend at `/var/www/cardmint-backend/` is deployed via rsync (not git clone).

### Deployment Command

```bash
rsync -avz \
  --exclude='node_modules' \
  --exclude='*.db*' \
  --exclude='data' \
  --exclude='artifacts' \
  --exclude='backups' \
  --exclude='.env' \
  --exclude='images' \
  --exclude='exports' \
  -e "ssh -i ~/.ssh/cardmint_droplet" \
  /home/kyle/CardMint-workspace/apps/backend/ \
  cardmint@157.245.213.233:/var/www/cardmint-backend/
```

### Post-Deploy Steps

```bash
# Install dependencies
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'cd /var/www/cardmint-backend && npm ci'

# Run migrations
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'cd /var/www/cardmint-backend && npm run migrate'

# Restart service
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo systemctl restart cardmint-backend'

# Verify health
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'curl -sS localhost:4000/health | jq'
```

### Environment Configuration

Backend environment file: `/etc/cardmint-backend.env`

Key variables (Dec 2025):
- `CARDMINT_ADMIN_API_KEY` - Bearer token for `/api/admin/*`
- `CAPTURE_INTERNAL_KEY` - Header for capture/calibration endpoints
- `DISPLAY_TOKEN` - Header for `/api/stock-summary/*`

### Service Management

```bash
# View logs
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo journalctl -u cardmint-backend -f'

# Restart
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo systemctl restart cardmint-backend'

# Status
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'sudo systemctl status cardmint-backend'
```

---

## Next Steps

### Completed ✅
- ✅ **Phase 2A-2B:** Droplet provisioning and SSH key setup
- ✅ **Phase 2C:** DNS configuration (nameservers + A records)
- ✅ **Phase 2E:** EverShop v2.0.1 installation with PostgreSQL 16
- ✅ **Phase 2F:** Nginx reverse proxy (port 3000 → 80/443)
- ✅ **Phase 2G:** Let's Encrypt SSL certificate (ECDSA, auto-renewal)
- ✅ **Phase 2H:** Security hardening (firewall, Fail2Ban, auto-updates)
- ✅ **Phase 2J:** Landing page + Basic Auth on admin (Codex-guided hardening)

### Pending (Phase 2I, 2K-2M)

**Phase 2I: Email Deliverability Setup (20 minutes)**
1. Choose email provider (Postmark $10/mo vs SendGrid $20/mo)
2. Add DNS records for SPF, DKIM, DMARC
3. Configure SMTP settings in `/opt/cardmint/.env`
4. Test email sending and verify authentication headers

**Phase 2K: Day-1 Analytics Setup (15 minutes)**
1. Create Google Analytics 4 property
2. Add GA4 measurement ID to EverShop
3. Set up Google Search Console
4. Submit sitemap.xml
5. Configure key event tracking

**Phase 2L: First Product Upload**
1. Access admin panel at https://cardmintshop.com/admin
2. Change admin password from default
3. Upload 10+ pilot products (CardMint operator-vetted inventory)
4. Configure shipping zones and payment gateway (Stripe)
5. Test checkout flow end-to-end

**Phase 2M: Final Verification (10 minutes)**
1. Comprehensive health check (DNS, HTTPS, SSL grade, admin access)
2. Browser testing checklist (desktop + mobile)
3. Performance testing (page load times, image optimization)
4. Security audit (headers, CSP, SSL Labs A+ verification)

### Ongoing Maintenance
- **Daily:** Monitor EverShop logs for errors: `docker compose -f /opt/cardmint/docker-compose.yml logs --tail=100`
- **Weekly:** Review Nginx access/error logs, check disk usage, verify backup completion
- **Monthly:** Review SSH access logs (`sudo journalctl -u sshd`), update EverShop if patches available
- **Quarterly:** Review firewall rules, security audit, performance optimization
- **Annually:** Rotate SSH keys (generate new key, add to droplet, remove old key)
- **As Needed:** Monitor DigitalOcean droplet metrics (CPU, RAM, Disk alerts)

---

**Document Version:** 5.0
**Maintained By:** Claude (Lead Developer)
**Reviewed By:** Kyle (Operator/CEO)
**Last Updated:** December 25, 2025 (prod-2025-12-27a deployment, security hardening)
**Next Review:** After first fulfillment E2E test
