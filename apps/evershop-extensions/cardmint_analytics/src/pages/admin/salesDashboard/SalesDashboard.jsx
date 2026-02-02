import React, { useState, useEffect, useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';

/**
 * Sales Dashboard - Revenue tracking with interactive forecasting
 *
 * Features:
 * - Historical revenue visualization (daily/weekly/monthly)
 * - Interactive growth scenario modeling (weekly granularity only)
 * - Metrics grid with KPIs
 *
 * Data sources:
 * - CardMint orders (Stripe)
 * - TCGPlayer marketplace orders
 * - eBay marketplace orders
 */

// Scenario presets for forecasting
const SCENARIO_PRESETS = {
  conservative: { momRate: 0.15, label: 'Conservative (~15% MoM)' },
  base: { momRate: 0.30, label: 'Base Case (~30% MoM)' },
  aggressive: { momRate: 0.50, label: 'Aggressive (~50% MoM)' },
};

// Convert MoM rate to weekly rate
function momToWeeklyRate(momRate) {
  return Math.pow(1 + momRate, 1 / 4.33) - 1;
}

// Format cents as dollars
function formatCurrency(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// Format number with commas
function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

// Get default date range (last 30 days)
function getDefaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

// Simple bar chart component
function RevenueChart({ data, projectedData, formatLabel }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
        No data available for the selected period
      </div>
    );
  }

  const allData = [...data, ...projectedData];
  const maxRevenue = Math.max(...allData.map((d) => d.netRevenueCents));
  const barMaxHeight = 180;

  return (
    <div style={{ overflowX: 'auto', paddingBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', minWidth: allData.length * 50, height: barMaxHeight + 40 }}>
        {allData.map((item, idx) => {
          const height = maxRevenue > 0 ? (item.netRevenueCents / maxRevenue) * barMaxHeight : 0;
          const isProjected = idx >= data.length;
          return (
            <div
              key={item.period}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flex: 1,
                minWidth: '45px',
              }}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: '40px',
                  height: `${height}px`,
                  backgroundColor: isProjected ? '#E0E7FF' : '#4F46E5',
                  borderRadius: '4px 4px 0 0',
                  transition: 'height 0.3s ease',
                  border: isProjected ? '2px dashed #6366F1' : 'none',
                }}
                title={`${formatLabel(item.period)}: ${formatCurrency(item.netRevenueCents)}`}
              />
              <span style={{ fontSize: '10px', color: '#666', marginTop: '4px', transform: 'rotate(-45deg)', whiteSpace: 'nowrap' }}>
                {formatLabel(item.period)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

RevenueChart.propTypes = {
  data: PropTypes.array.isRequired,
  projectedData: PropTypes.array,
  formatLabel: PropTypes.func.isRequired,
};

RevenueChart.defaultProps = {
  projectedData: [],
};

// Metrics card component
function MetricCard({ title, value, subtitle, trend }) {
  const trendColor = trend > 0 ? '#059669' : trend < 0 ? '#DC2626' : '#666';
  const trendIcon = trend > 0 ? '+' : '';

  return (
    <div
      style={{
        backgroundColor: '#fff',
        borderRadius: '8px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        padding: '16px',
      }}
    >
      <h3 style={{ fontSize: '12px', color: '#666', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{title}</h3>
      <p style={{ fontSize: '24px', fontWeight: 600, color: '#0A203F', marginBottom: '4px' }}>{value}</p>
      {subtitle && <p style={{ fontSize: '12px', color: '#666' }}>{subtitle}</p>}
      {trend !== undefined && (
        <p style={{ fontSize: '12px', color: trendColor, marginTop: '4px' }}>
          {trendIcon}{trend}% vs prev period
        </p>
      )}
    </div>
  );
}

MetricCard.propTypes = {
  title: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  trend: PropTypes.number,
};

// Forecast controls component (only shown for weekly granularity)
function ForecastControls({ scenario, customRate, onScenarioChange, onCustomRateChange, projectWeeks, onProjectWeeksChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
      <div>
        <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>Scenario</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          {Object.entries(SCENARIO_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => onScenarioChange(key)}
              style={{
                padding: '8px 12px',
                borderRadius: '6px',
                border: scenario === key ? '2px solid #4F46E5' : '1px solid #E5E7EB',
                backgroundColor: scenario === key ? '#EEF2FF' : '#fff',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: scenario === key ? 600 : 400,
              }}
            >
              {key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
          <button
            onClick={() => onScenarioChange('custom')}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: scenario === 'custom' ? '2px solid #4F46E5' : '1px solid #E5E7EB',
              backgroundColor: scenario === 'custom' ? '#EEF2FF' : '#fff',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: scenario === 'custom' ? 600 : 400,
            }}
          >
            Custom
          </button>
        </div>
      </div>

      {scenario === 'custom' && (
        <div>
          <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>MoM Growth %</label>
          <input
            type="range"
            min="0"
            max="100"
            value={customRate * 100}
            onChange={(e) => onCustomRateChange(Number(e.target.value) / 100)}
            style={{ width: '150px' }}
          />
          <span style={{ marginLeft: '8px', fontSize: '13px' }}>{(customRate * 100).toFixed(0)}%</span>
        </div>
      )}

      <div>
        <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>Project Weeks</label>
        <select
          value={projectWeeks}
          onChange={(e) => onProjectWeeksChange(Number(e.target.value))}
          style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #E5E7EB', fontSize: '13px' }}
        >
          <option value={4}>4 weeks</option>
          <option value={8}>8 weeks</option>
          <option value={12}>12 weeks</option>
        </select>
      </div>
    </div>
  );
}

ForecastControls.propTypes = {
  scenario: PropTypes.string.isRequired,
  customRate: PropTypes.number.isRequired,
  onScenarioChange: PropTypes.func.isRequired,
  onCustomRateChange: PropTypes.func.isRequired,
  projectWeeks: PropTypes.number.isRequired,
  onProjectWeeksChange: PropTypes.func.isRequired,
};

// Main dashboard component
export default function SalesDashboard() {
  const defaultRange = getDefaultDateRange();

  // Date range state
  const [startDate, setStartDate] = useState(defaultRange.start);
  const [endDate, setEndDate] = useState(defaultRange.end);
  const [granularity, setGranularity] = useState('weekly');
  const [source, setSource] = useState('all');

  // Data state
  const [summary, setSummary] = useState(null);
  const [revenueData, setRevenueData] = useState(null);
  const [discountData, setDiscountData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Forecast state
  const [scenario, setScenario] = useState('base');
  const [customRate, setCustomRate] = useState(0.30);
  const [projectWeeks, setProjectWeeks] = useState(4);

  // Forecasting only available for weekly granularity
  const forecastingEnabled = granularity === 'weekly';

  // Fetch data from backend via EverShop proxy
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ start: startDate, end: endDate, source });

      // Fetch all data in parallel via EverShop proxy endpoints
      const [summaryRes, revenueRes, discountRes] = await Promise.all([
        fetch(`/api/admin/api/dashboard/sales-summary?${params}`, { credentials: 'include' }),
        fetch(`/api/admin/api/dashboard/revenue-by-period?${params}&granularity=${granularity}`, { credentials: 'include' }),
        fetch(`/api/admin/api/dashboard/discount-analysis?${params}`, { credentials: 'include' }),
      ]);

      if (!summaryRes.ok) {
        const errData = await summaryRes.json().catch(() => ({}));
        throw new Error(errData.message || errData.error || `Summary fetch failed: ${summaryRes.status}`);
      }
      if (!revenueRes.ok) {
        const errData = await revenueRes.json().catch(() => ({}));
        throw new Error(errData.message || errData.error || `Revenue fetch failed: ${revenueRes.status}`);
      }
      if (!discountRes.ok) {
        const errData = await discountRes.json().catch(() => ({}));
        throw new Error(errData.message || errData.error || `Discount fetch failed: ${discountRes.status}`);
      }

      const [summaryData, revenueDataJson, discountDataJson] = await Promise.all([
        summaryRes.json(),
        revenueRes.json(),
        discountRes.json(),
      ]);

      setSummary(summaryData);
      setRevenueData(revenueDataJson);
      setDiscountData(discountDataJson);
    } catch (err) {
      console.error('Dashboard fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, granularity, source]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Calculate projected data (only for weekly granularity)
  const projectedData = useMemo(() => {
    if (!forecastingEnabled || !revenueData?.data || revenueData.data.length === 0) return [];

    const growthRate = scenario === 'custom' ? customRate : SCENARIO_PRESETS[scenario]?.momRate || 0.30;
    const weeklyRate = momToWeeklyRate(growthRate);

    const lastDataPoint = revenueData.data[revenueData.data.length - 1];
    const baseRevenue = lastDataPoint.netRevenueCents;
    const baseOrders = lastDataPoint.orders;

    const projected = [];
    for (let i = 1; i <= projectWeeks; i++) {
      const factor = Math.pow(1 + weeklyRate, i);
      projected.push({
        period: `+${i}w`,
        netRevenueCents: Math.round(baseRevenue * factor),
        orders: Math.round(baseOrders * factor),
        itemCount: 0,
        isProjected: true,
      });
    }

    return projected;
  }, [forecastingEnabled, revenueData, scenario, customRate, projectWeeks]);

  // Format period label based on granularity
  const formatPeriodLabel = useCallback((period) => {
    if (period.startsWith('+')) return period; // Projected periods
    if (granularity === 'weekly' && period.includes('-W')) {
      return period.replace(/^\d{4}-/, '');
    }
    if (granularity === 'monthly') {
      const [year, month] = period.split('-');
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${monthNames[parseInt(month, 10) - 1]} '${year.slice(2)}`;
    }
    return period.slice(5); // Remove year for daily
  }, [granularity]);

  const cardStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    padding: '20px',
    marginBottom: '20px',
  };

  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#0A203F' }}>Sales Dashboard</h1>
      </div>

      {/* Filters */}
      <div style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #E5E7EB', fontSize: '13px' }}
          />
        </div>
        <div>
          <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #E5E7EB', fontSize: '13px' }}
          />
        </div>
        <div>
          <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>Granularity</label>
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #E5E7EB', fontSize: '13px' }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>Source</label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #E5E7EB', fontSize: '13px' }}
          >
            <option value="all">All Sources</option>
            <option value="cardmint">CardMint Only</option>
            <option value="tcgplayer">TCGPlayer Only</option>
            <option value="ebay">eBay Only</option>
          </select>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          style={{
            padding: '8px 16px',
            backgroundColor: loading ? '#9CA3AF' : '#0A203F',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '13px',
          }}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ ...cardStyle, backgroundColor: '#FFEBEE', color: '#C62828' }}>
          Error: {error}
        </div>
      )}

      {/* Summary Metrics */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          <MetricCard title="Total Revenue" value={formatCurrency(summary.combined.totalNetRevenueCents)} subtitle={`${formatNumber(summary.combined.totalOrders)} orders`} />
          <MetricCard title="CardMint Revenue" value={formatCurrency(summary.cardmint.netRevenueCents)} subtitle={`${formatNumber(summary.cardmint.orderCount)} orders`} />
          <MetricCard title="TCGPlayer Revenue" value={formatCurrency(summary.marketplace.tcgplayer.revenueCents)} subtitle={`${formatNumber(summary.marketplace.tcgplayer.orderCount)} orders`} />
          <MetricCard title="Avg Order Value" value={formatCurrency(summary.combined.combinedAvgOrderValueCents)} subtitle="Combined AOV" />
          <MetricCard title="Total Discounts" value={formatCurrency(summary.cardmint.discountCents)} subtitle={summary.cardmint.topPromoCode ? `Top: ${summary.cardmint.topPromoCode}` : 'No promo codes used'} />
          <MetricCard title="Items Sold" value={formatNumber(summary.cardmint.itemCount)} subtitle="CardMint items" />
        </div>
      )}

      {/* Revenue Chart with Forecasting */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#0A203F', marginBottom: '4px' }}>
              Revenue Trend {forecastingEnabled ? '& Forecast' : ''}
            </h2>
            <p style={{ fontSize: '12px', color: '#666' }}>
              {forecastingEnabled
                ? 'Historical data (solid) + projected growth (dashed)'
                : `Historical data by ${granularity} (forecasting available in weekly view)`}
            </p>
          </div>
          {forecastingEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '12px', color: '#666' }}>
              <span><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#4F46E5', borderRadius: '2px', marginRight: '4px' }} />Historical</span>
              <span><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#E0E7FF', border: '1px dashed #6366F1', borderRadius: '2px', marginRight: '4px' }} />Projected</span>
            </div>
          )}
        </div>

        {forecastingEnabled && (
          <ForecastControls
            scenario={scenario}
            customRate={customRate}
            onScenarioChange={setScenario}
            onCustomRateChange={setCustomRate}
            projectWeeks={projectWeeks}
            onProjectWeeksChange={setProjectWeeks}
          />
        )}

        {loading ? (
          <div style={{ padding: '60px', textAlign: 'center', color: '#666' }}>Loading chart data...</div>
        ) : (
          <RevenueChart data={revenueData?.data || []} projectedData={projectedData} formatLabel={formatPeriodLabel} />
        )}

        {/* Disclaimer - only shown when forecasting is enabled */}
        {forecastingEnabled && (
          <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#FEF3C7', borderRadius: '6px', fontSize: '12px', color: '#92400E' }}>
            Projections are illustrative scenarios based on selected growth assumptions. Actual results may vary.
            <br />
            <span style={{ fontSize: '11px', color: '#A16207' }}>
              Scenario presets (15%/30%/50% MoM) are example rates for modeling purposes.
            </span>
          </div>
        )}
      </div>

      {/* Discount Analysis */}
      {discountData && (
        <div style={cardStyle}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#0A203F', marginBottom: '16px' }}>Discount Analysis</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
            {/* By Source */}
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>By Source</h3>
              {discountData.bySource.length === 0 ? (
                <p style={{ color: '#666', fontSize: '13px' }}>No discounts applied in this period</p>
              ) : (
                <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
                      <th style={{ textAlign: 'left', padding: '8px 0', color: '#666' }}>Source</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#666' }}>Orders</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#666' }}>Total</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#666' }}>Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discountData.bySource.map((row) => (
                      <tr key={row.source} style={{ borderBottom: '1px solid #F3F4F6' }}>
                        <td style={{ padding: '8px 0' }}>{row.source}</td>
                        <td style={{ textAlign: 'right', padding: '8px 0' }}>{formatNumber(row.orderCount)}</td>
                        <td style={{ textAlign: 'right', padding: '8px 0' }}>{formatCurrency(row.totalDiscountCents)}</td>
                        <td style={{ textAlign: 'right', padding: '8px 0' }}>{formatCurrency(row.avgDiscountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Top Promo Codes */}
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>Top Promo Codes</h3>
              {discountData.topPromoCodes.length === 0 ? (
                <p style={{ color: '#666', fontSize: '13px' }}>No promo codes used in this period</p>
              ) : (
                <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
                      <th style={{ textAlign: 'left', padding: '8px 0', color: '#666' }}>Code</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#666' }}>Uses</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#666' }}>Total Discount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discountData.topPromoCodes.slice(0, 5).map((row) => (
                      <tr key={row.code} style={{ borderBottom: '1px solid #F3F4F6' }}>
                        <td style={{ padding: '8px 0', fontFamily: 'monospace' }}>{row.code}</td>
                        <td style={{ textAlign: 'right', padding: '8px 0' }}>{formatNumber(row.usageCount)}</td>
                        <td style={{ textAlign: 'right', padding: '8px 0' }}>{formatCurrency(row.totalDiscountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Summary stats */}
          <div style={{ marginTop: '16px', display: 'flex', gap: '32px', fontSize: '13px', color: '#666' }}>
            <span>Discount Rate: <strong style={{ color: '#0A203F' }}>{(discountData.summary.discountRate * 100).toFixed(0)}%</strong> of orders</span>
            <span>Total Discounts: <strong style={{ color: '#0A203F' }}>{formatCurrency(discountData.summary.totalDiscountCents)}</strong></span>
            <span>Orders with Discount: <strong style={{ color: '#0A203F' }}>{formatNumber(discountData.summary.ordersWithDiscount)}</strong></span>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '12px', color: '#9CA3AF' }}>
        Data refreshed at {new Date().toLocaleString()} | All times UTC | Currency: USD
      </div>
    </div>
  );
}

export const layout = {
  areaId: 'content',
  sortOrder: 10,
};
