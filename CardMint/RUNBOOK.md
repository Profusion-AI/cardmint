# CardMint Production Runbook

## 🚨 Emergency Contacts & Escalation

**Primary On-Call**: Kyle Greenwell  
**Database**: Fly.io PostgreSQL cluster `cardmint-db`  
**Monitoring**: Internal health checks + Fly.io dashboard  

## 📊 System Overview

### Database Architecture
- **Primary**: `cardmint-db` Fly.io PostgreSQL cluster
- **Replica**: Automatically configured for HA
- **Connection Pool**: 5-20 connections via asyncpg
- **Target SLA**: <100ms p95 latency, 99.9% uptime

### Critical Metrics
- **Latency**: <100ms target, alert >150ms
- **Pool Utilization**: <80% normal, alert >90%
- **Replica Lag**: <10s normal, alert >30s
- **Storage**: <70% full, alert >85%

## 🔥 Emergency Procedures

### Database Connection Failures

**Symptoms**: Application returns 500 errors, "connection refused"

**Immediate Actions**:
```bash
# Check cluster status
flyctl status -a cardmint-db

# Check database health
flyctl postgres connect -a cardmint-db
# Inside psql: SELECT 1;

# Check replica status
flyctl postgres list
```

**Resolution**:
1. If primary down: Force failover to replica
```bash
flyctl postgres failover -a cardmint-db
```

2. If both down: Check Fly.io status page, escalate to Fly support

### High Latency (>150ms)

**Symptoms**: Slow application response, timeouts

**Investigation**:
```bash
# Check active connections
flyctl ssh console -a cardmint-db -C "psql -c \"SELECT count(*) FROM pg_stat_activity WHERE state='active';\""

# Check slow queries
flyctl ssh console -a cardmint-db -C "psql -c \"SELECT query, query_start, state FROM pg_stat_activity WHERE state='active' ORDER BY query_start;\""
```

**Resolution**:
1. Scale up machine if CPU >80%
```bash
flyctl machine update [machine-id] --vm-size performance-2x -a cardmint-db
```

2. Add connection pooling if connections >50

### Storage Full (>90%)

**Symptoms**: Write failures, "disk full" errors

**Immediate Actions**:
```bash
# Check storage usage
flyctl volumes list -a cardmint-db

# Emergency cleanup (if safe)
flyctl ssh console -a cardmint-db -C "psql -c \"VACUUM FULL;\""
```

**Resolution**:
```bash
# Scale up storage (requires restart)
flyctl volumes extend [volume-id] --size-gb 50 -a cardmint-db
```

### Data Loss / Corruption

**Symptoms**: Missing records, consistency errors

**Actions**:
1. **STOP ALL WRITES IMMEDIATELY**
2. Assess scope of data loss
3. Restore from latest backup (see Backup Procedures)

## 🔄 Operational Procedures

### Backup & Recovery

**Scheduled Backups**:
- Daily snapshots: 7-day retention
- WAL archival: Continuous (if enabled)

**Manual Backup**:
```bash
# Create snapshot
flyctl volumes snapshot create [volume-id] -a cardmint-db

# List snapshots
flyctl volumes snapshot list [volume-id]
```

**Recovery Process**:
```bash
# Create new cluster from snapshot
flyctl postgres create cardmint-db-restore --snapshot [snapshot-id]

# Update application connection string
flyctl secrets set DATABASE_URL="new-connection-string" -a [app-name]
```

### Failover Testing (Monthly)

**Planned Failover Drill**:
```bash
# 1. Announce maintenance window
# 2. Kill primary machine
flyctl machine kill [primary-machine-id] -a cardmint-db

# 3. Verify replica promotion
flyctl postgres connect -a cardmint-db
# Check: SELECT pg_is_in_recovery(); (should be false)

# 4. Test application connectivity
python3 production_cli.py health

# 5. Document results and recovery time
```

### Performance Monitoring

**Daily Health Checks**:
```bash
# Run automated health check
python3 production_cli.py health

# Check performance stats
python3 production_cli.py stats

# Monitor key metrics
flyctl logs -a cardmint-db | grep ERROR
```

**Load Testing (Weekly)**:
```bash
# Internal latency test
flyctl proxy 5433:5432 -a cardmint-db &
pgbench -h localhost -p 5433 -U postgres -c 20 -j 4 -T 300 -S cardmint

# Application-level test
python3 test_v03_production.py
```

### Schema Changes

**Migration Process**:
```bash
# 1. Create migration script
alembic revision --autogenerate -m "description"

# 2. Review generated migration
cat alembic/versions/[timestamp]_description.py

# 3. Test on staging (if available)
alembic upgrade head

# 4. Backup before production deploy
flyctl volumes snapshot create [volume-id] -a cardmint-db

# 5. Deploy to production
alembic upgrade head

# 6. Verify schema
python3 production_cli.py test-card
```

## 📈 Scaling Procedures

### Vertical Scaling

**When to Scale Up**:
- CPU usage >75% sustained >15 minutes
- Memory usage >85% sustained >10 minutes
- Latency >100ms p95 sustained >5 minutes

**Process**:
```bash
# Scale primary
flyctl machine update [primary-id] --vm-size performance-2x -a cardmint-db

# Scale replica (if needed)
flyctl machine update [replica-id] --vm-size performance-2x -a cardmint-db
```

### Connection Pool Scaling

**When to Add PgBouncer**:
- Connection count >100 peak
- "too many connections" errors
- Multiple application instances

**Setup**:
```bash
# Deploy PgBouncer sidecar
flyctl deploy --dockerfile Dockerfile.pgbouncer -a cardmint-db-bouncer
```

### Read Replica Addition

**When to Add Read Replicas**:
- Read/write ratio >5:1
- Analytics queries impacting OLTP performance
- Geographic distribution needed

## 🔒 Security Procedures

### Credential Rotation (Quarterly)

```bash
# 1. Generate new password
NEW_PASS=$(openssl rand -base64 32)

# 2. Update database password
flyctl ssh console -a cardmint-db -C "psql -c \"ALTER USER postgres PASSWORD '$NEW_PASS';\""

# 3. Update application secrets
flyctl secrets set DATABASE_URL="postgres://postgres:$NEW_PASS@cardmint-db.flycast:5432" -a [app-name]

# 4. Test connectivity
python3 production_cli.py health

# 5. Update runbook if needed
```

### Security Audit (Monthly)

```bash
# Check for unauthorized access
flyctl ssh console -a cardmint-db -C "psql -c \"SELECT usename, valuntil FROM pg_user;\""

# Review active connections
flyctl ssh console -a cardmint-db -C "psql -c \"SELECT usename, application_name, client_addr FROM pg_stat_activity;\""

# Audit database permissions
flyctl ssh console -a cardmint-db -C "psql -c \"\\dp\""
```

## 📞 Incident Response

### Severity Levels

**P0 - Critical**: Complete outage, data loss risk
- Response: Immediate (<15 minutes)
- Actions: All hands, emergency procedures

**P1 - High**: Degraded performance, user impact
- Response: <1 hour
- Actions: Investigate, mitigate, schedule fix

**P2 - Medium**: Minor issues, no user impact
- Response: <4 hours
- Actions: Standard troubleshooting

### Incident Communication

**Internal Slack Channel**: #cardmint-ops  
**Status Page**: Internal dashboard  
**Customer Communication**: Email + in-app notifications  

### Post-Incident Review

1. Root cause analysis within 48 hours
2. Action items with owners and timelines
3. Runbook updates based on lessons learned
4. Prevention measures implementation

## 📋 Maintenance Windows

**Scheduled Maintenance**: 
- Weekly: Sunday 02:00-04:00 UTC
- Monthly: First Saturday 01:00-06:00 UTC

**Emergency Maintenance**:
- Security patches: As needed with 24h notice
- Critical fixes: Immediate with notification

## 🔧 Tools & Resources

**Required CLI Tools**:
- `flyctl` - Fly.io platform management
- `psql` - PostgreSQL client
- `pgbench` - Database load testing
- `alembic` - Schema migrations

**Monitoring Dashboards**:
- Fly.io console: https://fly.io/dashboard
- Application metrics: Internal `/health` endpoints

**Documentation**:
- Fly.io Postgres docs: https://fly.io/docs/postgres/
- PostgreSQL docs: https://postgresql.org/docs/
- asyncpg docs: https://magicstack.github.io/asyncpg/