import React, { useState, useEffect } from 'react';
import FunnelChart from '../../../components/FunnelChart';

/**
 * Analytics Dashboard Page
 * Shows conversion funnel and key metrics from PostHog
 * Gracefully degrades when PostHog admin API is not configured
 */
export default function AnalyticsDashboard() {
  const [funnelData, setFunnelData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchFunnelData();
  }, []);

  async function fetchFunnelData() {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/analytics/funnels', {
        credentials: 'include',
      });

      const data = await response.json();

      // Handle non-2xx responses that still return JSON (503 = not configured, 502 = upstream error)
      if (!response.ok) {
        setFunnelData(data); // Still set data so we can show the message
        if (data.configured === false) {
          setError(null); // Not an error, just not configured
        } else {
          setError(data.error || `HTTP ${response.status}`);
        }
      } else {
        setFunnelData(data);
        setError(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const cardStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    padding: '20px',
    marginBottom: '20px',
  };

  const headerStyle = {
    fontSize: '18px',
    fontWeight: 600,
    marginBottom: '4px',
    color: '#0A203F',
  };

  const subheaderStyle = {
    fontSize: '12px',
    color: '#666',
    marginBottom: '16px',
  };

  return (
    <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '20px', color: '#0A203F' }}>
        Analytics Dashboard
      </h1>

      {/* Conversion Funnel Card */}
      <div style={cardStyle}>
        <h2 style={headerStyle}>Conversion Funnel</h2>
        <p style={subheaderStyle}>
          {funnelData?.period === 'last_7_days' ? 'Last 7 Days' : funnelData?.period || 'Last 7 Days'}
          {funnelData?.last_updated && (
            <span> · Updated {new Date(funnelData.last_updated).toLocaleString()}</span>
          )}
          {funnelData?.source && (
            <span
              style={{
                marginLeft: '8px',
                padding: '2px 6px',
                backgroundColor: funnelData.source === 'posthog' ? '#E8F5E9' : '#FFF3E0',
                borderRadius: '4px',
                fontSize: '10px',
                textTransform: 'uppercase',
              }}
            >
              {funnelData.source}
            </span>
          )}
        </p>

        {loading && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
            Loading funnel data...
          </div>
        )}

        {error && (
          <div style={{ padding: '20px', backgroundColor: '#FFEBEE', borderRadius: '4px', color: '#C62828' }}>
            Error loading analytics: {error}
          </div>
        )}

        {!loading && !error && funnelData && (
          <>
            {funnelData.configured === false ? (
              <div style={{ padding: '20px', backgroundColor: '#E3F2FD', borderRadius: '4px', textAlign: 'center' }}>
                <h3 style={{ color: '#1565C0', marginBottom: '8px' }}>PostHog Not Configured</h3>
                <p style={{ color: '#1976D2', fontSize: '14px', marginBottom: '12px' }}>
                  {funnelData.message}
                </p>
                <p style={{ color: '#666', fontSize: '12px' }}>
                  Required: POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID
                </p>
              </div>
            ) : (
              <>
                <FunnelChart steps={funnelData.steps} />
                {funnelData.message && (
                  <div style={{ padding: '12px', backgroundColor: '#FFF8E1', borderRadius: '4px', fontSize: '13px', color: '#F57C00' }}>
                    {funnelData.message}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Quick Stats Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        <div style={cardStyle}>
          <h3 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>Total Product Views</h3>
          <p style={{ fontSize: '28px', fontWeight: 600, color: '#0A203F' }}>
            {funnelData?.steps?.[0]?.count?.toLocaleString() ?? '—'}
          </p>
        </div>

        <div style={cardStyle}>
          <h3 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>Cart Additions</h3>
          <p style={{ fontSize: '28px', fontWeight: 600, color: '#0A203F' }}>
            {funnelData?.steps?.[1]?.count?.toLocaleString() ?? '—'}
          </p>
        </div>

        <div style={cardStyle}>
          <h3 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>Checkouts Started</h3>
          <p style={{ fontSize: '28px', fontWeight: 600, color: '#0A203F' }}>
            {funnelData?.steps?.[2]?.count?.toLocaleString() ?? '—'}
          </p>
        </div>

        <div style={cardStyle}>
          <h3 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>Orders Completed</h3>
          <p style={{ fontSize: '28px', fontWeight: 600, color: '#4ADC61' }}>
            {funnelData?.steps?.[3]?.count?.toLocaleString() ?? '—'}
          </p>
        </div>
      </div>

      {/* PostHog Link */}
      <div style={{ marginTop: '20px', textAlign: 'center' }}>
        <a
          href="https://us.posthog.com/insights"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: '#0A203F',
            textDecoration: 'none',
            fontSize: '13px',
          }}
        >
          View detailed insights in PostHog →
        </a>
      </div>
    </div>
  );
}

export const layout = {
  areaId: 'content',
  sortOrder: 10,
};
