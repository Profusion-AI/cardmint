import React, { useState, useEffect, useCallback } from 'react';

/**
 * Unmatched Tracking Panel Component
 *
 * Displays EasyPost tracking records that couldn't be auto-linked to orders.
 * Allows operators to manually match or ignore unmatched tracking.
 */
export default function UnmatchedTrackingPanel({ onResolved }) {
  const [unmatched, setUnmatched] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(null);

  // Fetch unmatched tracking
  const fetchUnmatched = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/admin/api/fulfillment/marketplace/unmatched-tracking?limit=10', {
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setUnmatched(data.unmatched || []);
    } catch (err) {
      setError(err.message);
      setUnmatched([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUnmatched();
  }, [fetchUnmatched]);

  // Auto-expand when there's an error so users notice it
  useEffect(() => {
    if (error) {
      setExpanded(true);
    }
  }, [error]);

  // Handle ignore action
  const handleIgnore = async (id) => {
    try {
      setResolving(id);

      const response = await fetch(`/api/admin/api/fulfillment/marketplace/unmatched-tracking/${id}/resolve`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'ignore' }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Refresh list
      await fetchUnmatched();
      if (onResolved) onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setResolving(null);
    }
  };

  // Don't render if no unmatched records and no error
  // (Keep panel visible if there's an error to show)
  if (!loading && unmatched.length === 0 && !error) {
    return null;
  }

  // Styles
  const containerStyle = {
    backgroundColor: '#FFF8E1',
    borderRadius: '8px',
    marginBottom: '20px',
    overflow: 'hidden',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    cursor: 'pointer',
    backgroundColor: '#FFE082',
  };

  const headerTitleStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontWeight: 600,
    color: '#F57C00',
  };

  const badgeStyle = {
    backgroundColor: error ? '#C62828' : '#F57C00',
    color: '#fff',
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 600,
  };

  const expandIconStyle = {
    color: '#F57C00',
    transition: 'transform 0.2s ease',
    transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
  };

  const bodyStyle = {
    display: expanded ? 'block' : 'none',
    padding: '16px',
  };

  const tableStyle = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  };

  const thStyle = {
    padding: '8px 12px',
    textAlign: 'left',
    borderBottom: '1px solid #FFE082',
    fontWeight: 600,
    color: '#E65100',
    fontSize: '11px',
    textTransform: 'uppercase',
  };

  const tdStyle = {
    padding: '8px 12px',
    borderBottom: '1px solid #FFE082',
    color: '#374151',
  };

  const buttonStyle = {
    padding: '4px 12px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 500,
  };

  const ignoreButtonStyle = {
    ...buttonStyle,
    backgroundColor: '#f3f4f6',
    color: '#374151',
  };

  const loadingStyle = {
    padding: '20px',
    textAlign: 'center',
    color: '#F57C00',
  };

  const errorStyle = {
    padding: '12px',
    backgroundColor: '#FFEBEE',
    borderRadius: '6px',
    color: '#C62828',
    margin: '0 16px 16px 16px',
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle} onClick={() => setExpanded(!expanded)}>
        <div style={headerTitleStyle}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>Unmatched Tracking</span>
          <span style={badgeStyle}>{error ? '!' : unmatched.length}</span>
        </div>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={expandIconStyle}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Body */}
      <div style={bodyStyle}>
        {loading && (
          <div style={loadingStyle}>Loading unmatched tracking...</div>
        )}

        {error && (
          <div style={errorStyle}>{error}</div>
        )}

        {!loading && !error && unmatched.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Tracking #</th>
                <th style={thStyle}>Carrier</th>
                <th style={thStyle}>Signed By</th>
                <th style={thStyle}>Dest ZIP</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((item) => (
                <tr key={item.id}>
                  <td style={tdStyle}>
                    <strong>{item.tracking_number}</strong>
                  </td>
                  <td style={tdStyle}>{item.carrier || '—'}</td>
                  <td style={tdStyle}>{item.signed_by || '—'}</td>
                  <td style={tdStyle}>{item.destination_zip || '—'}</td>
                  <td style={tdStyle}>{item.easypost_status || '—'}</td>
                  <td style={tdStyle}>
                    <button
                      style={ignoreButtonStyle}
                      onClick={() => handleIgnore(item.id)}
                      disabled={resolving === item.id}
                    >
                      {resolving === item.id ? 'Ignoring...' : 'Ignore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: '12px', fontSize: '12px', color: '#E65100' }}>
          These tracking records couldn't be automatically matched to orders.
          Review each one and either match it manually or ignore it.
        </div>
      </div>
    </div>
  );
}
