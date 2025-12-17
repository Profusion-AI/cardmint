# cardmint_analytics

PostHog analytics integration for CardMint EverShop.

## Configuration

### Required Environment Variables

```bash
# Event Ingestion (Project API Key)
POSTHOG_API_KEY=phc_...           # Required for event capture
POSTHOG_HOST=https://us.i.posthog.com

# Admin Dashboard API (Personal API Key)
POSTHOG_PERSONAL_API_KEY=phx_...  # Required for insights queries
POSTHOG_PROJECT_ID=<project_id>   # Required for admin API calls
```

### Modes of Operation

| Mode | POSTHOG_API_KEY | POSTHOG_PERSONAL_API_KEY | POSTHOG_PROJECT_ID | Behavior |
|------|-----------------|--------------------------|---------------------|----------|
| Full | Set | Set | Set | Event capture + admin dashboard |
| Ingestion Only | Set | - | - | Event capture only, dashboard shows config prompt |
| Disabled | - | - | - | All analytics disabled |

## Event Mapping

| EverShop Event | PostHog Event | Funnel Stage |
|----------------|---------------|--------------|
| productViewed | product_viewed | Top of funnel |
| cartUpdated | cart_updated | Interest |
| checkoutStarted | checkout_started | Intent |
| orderPlaced | checkout_completed | Conversion |

**Note:** EverShop event names need verification against actual events emitted by the platform. Update subscriber directory names if they differ.

## Admin Dashboard

Access: `/admin/analytics` (requires admin authentication)

Features:
- Conversion funnel visualization
- Quick stats cards (views, carts, checkouts, orders)
- Link to PostHog dashboard for detailed insights

## File Structure

```
cardmint_analytics/
├── services/
│   ├── PostHogProxyService.js    # PostHog client singleton
│   └── AnalyticsCacheService.js  # 5-min TTL in-memory cache
├── subscribers/                   # EverShop event handlers
│   ├── cartUpdated/
│   ├── checkoutStarted/
│   ├── orderPlaced/
│   └── productViewed/
├── api/admin/analytics/          # Admin API endpoints
├── pages/admin/
│   ├── analytics/                # Dashboard UI page
│   └── all/                      # Components on all admin pages
│       └── AnalyticsSidebarLink.jsx
├── components/
│   └── FunnelChart.jsx           # Funnel visualization
├── bootstrap.js                  # Initialization
└── scripts/verify_posthog_events.sh
```

## Verification

```bash
# Set env vars
export POSTHOG_API_KEY=phc_...
export POSTHOG_HOST=https://us.i.posthog.com

# Run verification script
cd apps/evershop-extensions/cardmint_analytics
./scripts/verify_posthog_events.sh
```

## Adding New Events

1. Define schema in `docs/analytics/event-taxonomy.md`
2. Create subscriber in `subscribers/<event_name>/[track<Name>]handler.js`
3. Use the PostHogProxyService singleton:

```javascript
const { posthogProxy } = require("../../services/PostHogProxyService");

module.exports = async function trackMyEvent(data) {
  if (!posthogProxy.enabled) {
    return;
  }

  await posthogProxy.captureEvent({
    distinctId: getDistinctId(data),
    event: "my_event_name",
    properties: { /* ... */ },
  });
};
```

## Related Documentation

- [Event Taxonomy](../../../docs/analytics/event-taxonomy.md)
- [PII Masking Policy](../../../docs/analytics/pii-masking.md)
- [Analytics README](../../../docs/analytics/README.md)
