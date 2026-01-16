import React, { useState, useEffect, useCallback, useRef } from 'react';
import UnifiedGrid from '../../../components/UnifiedGrid.js';
import ImportModal from '../../../components/ImportModal.js';
import UnmatchedTrackingPanel from '../../../components/UnmatchedTrackingPanel.js';
import PrintQueuePanel from '../../../components/PrintQueuePanel.js';

/**
 * Fulfillment Dashboard Page
 *
 * Unified view of all fulfillments:
 * - CardMint (Stripe) orders
 * - TCGPlayer marketplace orders
 * - Future: eBay marketplace orders
 *
 * Features:
 * - Source tabs (All | CardMint | TCGPlayer)
 * - Status filtering
 * - CSV import modals
 * - Unmatched tracking resolution
 */
const DASHBOARD_STATE_KEY = 'cardmint.fulfillment.dashboard.state.v1';
const DASHBOARD_STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function readDashboardState() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt > DASHBOARD_STATE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDashboardState(state) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(DASHBOARD_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export default function FulfillmentDashboard() {
  const savedState = readDashboardState();
  const savedScrollYRef = useRef(typeof savedState?.scrollY === 'number' ? savedState.scrollY : null);
  const didRestoreScrollRef = useRef(false);

  // State
  const [activeSource, setActiveSource] = useState(savedState?.activeSource || 'all');
  const [statusFilter, setStatusFilter] = useState(savedState?.statusFilter || '');
  const [fulfillments, setFulfillments] = useState([]);
  const [counts, setCounts] = useState({ cardmint: 0, marketplace: 0 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [pagination, setPagination] = useState(savedState?.pagination || { limit: 20, offset: 0 });
  const [toast, setToast] = useState({ show: false, message: '', fading: false });
  const [stats, setStats] = useState({ pendingLabels: 0, unmatchedTracking: 0, exceptions: 0, shippedToday: 0 });
  const [isRematching, setIsRematching] = useState(false);
  const [unmatchedRefreshTrigger, setUnmatchedRefreshTrigger] = useState(0);

  // Fetch stats (actionable counts)
  const fetchStats = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/api/fulfillment/stats', {
        credentials: 'include',
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        setStats({
          pendingLabels: data.pendingLabels ?? 0,
          unmatchedTracking: data.unmatchedTracking ?? 0,
          exceptions: data.exceptions ?? 0,
          shippedToday: data.shippedToday ?? 0,
        });
      }
    } catch (err) {
      // Stats fetch failure is non-critical, just log
      console.warn('Failed to fetch stats:', err);
    }
  }, []);

  // Fetch fulfillments
  const fetchFulfillments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (activeSource !== 'all') params.set('source', activeSource);
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', String(pagination.limit));
      params.set('offset', String(pagination.offset));

      const response = await fetch(`/api/admin/api/fulfillment/unified?${params}`, {
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setFulfillments(data.fulfillments || []);
      setCounts(data.counts || { cardmint: 0, marketplace: 0 });
      setTotal(data.total || 0);

      // Also refresh stats when fulfillments change
      fetchStats();
    } catch (err) {
      setError(err.message);
      setFulfillments([]);
    } finally {
      setLoading(false);
    }
  }, [activeSource, statusFilter, pagination, fetchStats]);

  useEffect(() => {
    fetchFulfillments();
  }, [fetchFulfillments]);

  // Restore scroll position once after returning from order details.
  useEffect(() => {
    if (loading) return;
    if (didRestoreScrollRef.current) return;
    if (savedScrollYRef.current == null) return;

    const y = savedScrollYRef.current;
    savedScrollYRef.current = null;
    didRestoreScrollRef.current = true;

    // Allow layout to settle before scrolling.
    setTimeout(() => {
      try {
        window.scrollTo(0, y);
      } catch {
        // ignore
      }
    }, 0);
  }, [loading]);

  const saveDashboardState = useCallback(() => {
    writeDashboardState({
      activeSource,
      statusFilter,
      pagination,
      scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
      savedAt: Date.now(),
    });
  }, [activeSource, statusFilter, pagination]);

  // Handlers
  const handleSourceChange = (source) => {
    setActiveSource(source);
    setPagination({ ...pagination, offset: 0 });
  };

  const handleStatusChange = (status) => {
    setStatusFilter(status);
    setPagination({ ...pagination, offset: 0 });
  };

  const handleImportClick = () => {
    setShowImportModal(true);
  };

  const handleImportClose = (shouldRefresh) => {
    setShowImportModal(false);
    if (shouldRefresh) {
      fetchFulfillments();
      // Trigger UnmatchedTrackingPanel refresh (EasyPost import adds unmatched entries)
      setUnmatchedRefreshTrigger(prev => prev + 1);
      // Show success toast
      setToast({ show: true, message: 'Upload Success!', fading: false });
      // Start fade after 4.5s, hide after 5s
      setTimeout(() => setToast(t => ({ ...t, fading: true })), 4500);
      setTimeout(() => setToast({ show: false, message: '', fading: false }), 5000);
    }
  };

  const handlePageChange = (newOffset) => {
    setPagination({ ...pagination, offset: newOffset });
  };

  const handleRefreshTracking = async () => {
    setIsRematching(true);
    try {
      const response = await fetch('/api/admin/api/fulfillment/marketplace/rematch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeUspsFallback: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Refresh failed');
      }
      // Refresh data (fetchFulfillments already triggers fetchStats)
      await fetchFulfillments();
      // Trigger UnmatchedTrackingPanel refresh
      setUnmatchedRefreshTrigger(prev => prev + 1);
      // Build detailed toast message
      const parts = [];
      const checked = Number.isFinite(data.checked) ? data.checked : (data.refreshed || 0);
      if (checked > 0) {
        parts.push(`Checked ${checked} tracking entries`);
      }
      if (data.statusUpdated > 0) {
        parts.push(`${data.statusUpdated} status${data.statusUpdated > 1 ? 'es' : ''} updated`);
      }
      if (data.autoResolved > 0) {
        parts.push(`${data.autoResolved} matched by tracking number`);
      }
      if (data.matched > 0) {
        parts.push(`${data.matched} matched to orders`);
      }
      const errorCount = (data.refreshErrors || 0) + (data.uspsErrors || 0);
      if (errorCount > 0) {
        parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
      }
      const message =
        parts.length === 1 && errorCount > 0
          ? `Refresh completed with ${errorCount} error${errorCount > 1 ? 's' : ''}`
          : parts.length > 0
            ? parts.join(', ')
            : 'No updates needed';
      setToast({ show: true, message, fading: false });
      setTimeout(() => setToast(t => ({ ...t, fading: true })), 4500);
      setTimeout(() => setToast({ show: false, message: '', fading: false }), 5000);
    } catch (err) {
      setToast({ show: true, message: `Refresh failed: ${err.message}`, fading: false });
      setTimeout(() => setToast(t => ({ ...t, fading: true })), 4500);
      setTimeout(() => setToast({ show: false, message: '', fading: false }), 5000);
    } finally {
      setIsRematching(false);
    }
  };

  // Styles
  const containerStyle = {
    padding: '20px',
    maxWidth: '1400px',
    margin: '0 auto',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
  };

  const titleStyle = {
    fontSize: '24px',
    fontWeight: 600,
    color: '#0A203F',
  };

  const actionsStyle = {
    display: 'flex',
    gap: '12px',
  };

  const buttonStyle = {
    padding: '8px 16px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
    transition: 'all 0.2s ease',
  };

  const primaryButtonStyle = {
    ...buttonStyle,
    backgroundColor: '#4ADC61',
    color: '#fff',
  };

  const secondaryButtonStyle = {
    ...buttonStyle,
    backgroundColor: '#f3f4f6',
    color: '#374151',
  };

  const tabsContainerStyle = {
    display: 'flex',
    gap: '4px',
    marginBottom: '20px',
    backgroundColor: '#f3f4f6',
    padding: '4px',
    borderRadius: '8px',
    width: 'fit-content',
  };

  const tabStyle = (isActive) => ({
    padding: '8px 16px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
    backgroundColor: isActive ? '#fff' : 'transparent',
    color: isActive ? '#0A203F' : '#6B7280',
    boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
    transition: 'all 0.2s ease',
  });

  const filtersRowStyle = {
    display: 'flex',
    gap: '16px',
    marginBottom: '20px',
    alignItems: 'center',
  };

  const selectStyle = {
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    fontSize: '14px',
    backgroundColor: '#fff',
    minWidth: '150px',
  };

  const statsRowStyle = {
    display: 'flex',
    gap: '16px',
    marginBottom: '20px',
  };

  const statCardStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    padding: '16px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    minWidth: '120px',
  };

  const statLabelStyle = {
    fontSize: '12px',
    color: '#6B7280',
    marginBottom: '4px',
  };

  const statValueStyle = {
    fontSize: '24px',
    fontWeight: 600,
    color: '#0A203F',
  };

  const errorStyle = {
    padding: '20px',
    backgroundColor: '#FFEBEE',
    borderRadius: '8px',
    color: '#C62828',
    marginBottom: '20px',
  };

  const toastStyle = {
    position: 'fixed',
    top: '20px',
    right: '20px',
    backgroundColor: '#4ADC61',
    color: '#0A203F',
    padding: '16px 24px',
    borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(74, 220, 97, 0.4)',
    fontWeight: 600,
    fontSize: '14px',
    zIndex: 1001,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    opacity: toast.fading ? 0 : 1,
    transform: toast.fading ? 'translateY(-10px)' : 'translateY(0)',
    transition: 'opacity 0.5s ease, transform 0.5s ease',
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <h1 style={titleStyle}>Fulfillment Dashboard</h1>
        <div style={actionsStyle}>
          <button
            style={secondaryButtonStyle}
            onClick={handleRefreshTracking}
            disabled={isRematching}
          >
            {isRematching ? 'Refreshing...' : 'Refresh Tracking'}
          </button>
          <button
            style={primaryButtonStyle}
            onClick={handleImportClick}
          >
            Import CSV
          </button>
        </div>
      </div>

      {/* Stats Row - Actionable Counts */}
      <div style={statsRowStyle}>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Pending Labels</div>
          <div style={{
            ...statValueStyle,
            color: stats.pendingLabels > 0 ? '#F57C00' : '#0A203F',
          }}>{stats.pendingLabels}</div>
        </div>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Unmatched Tracking</div>
          <div style={{
            ...statValueStyle,
            color: stats.unmatchedTracking > 0 ? '#E53935' : '#0A203F',
          }}>{stats.unmatchedTracking}</div>
        </div>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Exceptions</div>
          <div style={{
            ...statValueStyle,
            color: stats.exceptions > 0 ? '#C62828' : '#0A203F',
          }}>{stats.exceptions}</div>
        </div>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Shipped Today</div>
          <div style={{
            ...statValueStyle,
            color: stats.shippedToday > 0 ? '#2E7D32' : '#0A203F',
          }}>{stats.shippedToday}</div>
        </div>
      </div>

      {/* Phase 5: Print queue + agent heartbeat */}
      <PrintQueuePanel />

      {/* Source Tabs */}
      <div style={tabsContainerStyle}>
        <button
          style={tabStyle(activeSource === 'all')}
          onClick={() => handleSourceChange('all')}
        >
          All Sources
        </button>
        <button
          style={tabStyle(activeSource === 'cardmint')}
          onClick={() => handleSourceChange('cardmint')}
        >
          CardMint
        </button>
        <button
          style={tabStyle(activeSource === 'tcgplayer')}
          onClick={() => handleSourceChange('tcgplayer')}
        >
          TCGPlayer
        </button>
      </div>

      {/* Filters Row */}
      <div style={filtersRowStyle}>
        <label style={{ fontSize: '14px', color: '#374151' }}>
          Status:
          <select
            style={selectStyle}
            value={statusFilter}
            onChange={(e) => handleStatusChange(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="label_purchased">Label Purchased</option>
            <option value="shipped">Shipped</option>
            <option value="in_transit">In Transit</option>
            <option value="delivered">Delivered</option>
            <option value="exception">Exception</option>
          </select>
        </label>
        <button
          style={secondaryButtonStyle}
          onClick={fetchFulfillments}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div style={errorStyle}>
          Error loading fulfillments: {error}
        </div>
      )}

      {/* Unmatched Tracking Panel */}
      <UnmatchedTrackingPanel onResolved={fetchFulfillments} refreshTrigger={unmatchedRefreshTrigger} />

      {/* Fulfillment Grid */}
      <UnifiedGrid
        fulfillments={fulfillments}
        loading={loading}
        total={total}
        limit={pagination.limit}
        offset={pagination.offset}
        onPageChange={handlePageChange}
        onRefresh={fetchFulfillments}
        onOrderClick={saveDashboardState}
        onOpenImportModal={handleImportClick}
      />

      {/* Import Modal (unified - auto-detects format) */}
      {showImportModal && (
        <ImportModal
          onClose={handleImportClose}
        />
      )}

      {/* Success Toast */}
      {toast.show && (
        <div style={toastStyle}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          {toast.message}
        </div>
      )}
    </div>
  );
}

export const layout = {
  areaId: 'content',
  sortOrder: 10,
};
