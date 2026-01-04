import React, { useState, useEffect, useCallback } from 'react';
import UnifiedGrid from '../../../components/UnifiedGrid.jsx';
import ImportModal from '../../../components/ImportModal.jsx';
import UnmatchedTrackingPanel from '../../../components/UnmatchedTrackingPanel.jsx';
import PrintQueuePanel from '../../../components/PrintQueuePanel.jsx';

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
export default function FulfillmentDashboard() {
  // State
  const [activeSource, setActiveSource] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [fulfillments, setFulfillments] = useState([]);
  const [counts, setCounts] = useState({ cardmint: 0, marketplace: 0 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importType, setImportType] = useState(null); // 'tcgplayer' | 'easypost'
  const [pagination, setPagination] = useState({ limit: 20, offset: 0 });

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
    } catch (err) {
      setError(err.message);
      setFulfillments([]);
    } finally {
      setLoading(false);
    }
  }, [activeSource, statusFilter, pagination]);

  useEffect(() => {
    fetchFulfillments();
  }, [fetchFulfillments]);

  // Handlers
  const handleSourceChange = (source) => {
    setActiveSource(source);
    setPagination({ ...pagination, offset: 0 });
  };

  const handleStatusChange = (status) => {
    setStatusFilter(status);
    setPagination({ ...pagination, offset: 0 });
  };

  const handleImportClick = (type) => {
    setImportType(type);
    setShowImportModal(true);
  };

  const handleImportClose = (shouldRefresh) => {
    setShowImportModal(false);
    setImportType(null);
    if (shouldRefresh) {
      fetchFulfillments();
    }
  };

  const handlePageChange = (newOffset) => {
    setPagination({ ...pagination, offset: newOffset });
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

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <h1 style={titleStyle}>Fulfillment Dashboard</h1>
        <div style={actionsStyle}>
          <button
            style={secondaryButtonStyle}
            onClick={() => handleImportClick('easypost')}
          >
            Import EasyPost Tracking
          </button>
          <button
            style={primaryButtonStyle}
            onClick={() => handleImportClick('tcgplayer')}
          >
            Import TCGPlayer Orders
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div style={statsRowStyle}>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Total Orders</div>
          <div style={statValueStyle}>{total}</div>
        </div>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>CardMint</div>
          <div style={statValueStyle}>{counts.cardmint}</div>
        </div>
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Marketplace</div>
          <div style={statValueStyle}>{counts.marketplace}</div>
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
      <UnmatchedTrackingPanel onResolved={fetchFulfillments} />

      {/* Fulfillment Grid */}
      <UnifiedGrid
        fulfillments={fulfillments}
        loading={loading}
        total={total}
        limit={pagination.limit}
        offset={pagination.offset}
        onPageChange={handlePageChange}
      />

      {/* Import Modal */}
      {showImportModal && (
        <ImportModal
          type={importType}
          onClose={handleImportClose}
        />
      )}
    </div>
  );
}

export const layout = {
  areaId: 'content',
  sortOrder: 10,
};
