import React, { useState } from 'react';
import RatesModal from './RatesModal.jsx';
import MarketplaceShipmentActions from './MarketplaceShipmentActions.jsx';

/**
 * Unified Fulfillment Grid Component
 *
 * Displays fulfillments from all sources in a unified table format.
 * Supports pagination and shows source-specific details.
 * Includes action buttons for marketplace shipments (Phase 4).
 */
export default function UnifiedGrid({
  fulfillments = [],
  loading = false,
  total = 0,
  limit = 20,
  offset = 0,
  onPageChange,
  onRefresh,
}) {
  const [ratesModalOpen, setRatesModalOpen] = useState(false);
  const [selectedShipment, setSelectedShipment] = useState(null);

  const handleOpenRatesModal = (shipment) => {
    setSelectedShipment(shipment);
    setRatesModalOpen(true);
  };

  const handleCloseRatesModal = () => {
    setRatesModalOpen(false);
    setSelectedShipment(null);
  };

  const handleLabelPurchased = (data) => {
    // Refresh the grid to show updated status
    if (onRefresh) {
      onRefresh();
    }
  };

  const handleStatusChange = (shipmentId, newStatus) => {
    // Refresh the grid to show updated status
    if (onRefresh) {
      onRefresh();
    }
  };
  // Styles
  const containerStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    overflow: 'hidden',
  };

  const tableStyle = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '14px',
  };

  const thStyle = {
    padding: '12px 16px',
    textAlign: 'left',
    backgroundColor: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    fontWeight: 600,
    color: '#374151',
    fontSize: '12px',
    textTransform: 'uppercase',
  };

  const tdStyle = {
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
    color: '#374151',
  };

  const sourceTagStyle = (source) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 500,
    textTransform: 'uppercase',
    backgroundColor: source === 'cardmint' ? '#E8F5E9' : source === 'tcgplayer' ? '#E3F2FD' : '#FFF3E0',
    color: source === 'cardmint' ? '#2E7D32' : source === 'tcgplayer' ? '#1565C0' : '#E65100',
  });

  const statusTagStyle = (status) => {
    const colors = {
      pending: { bg: '#FFF8E1', color: '#F57C00' },
      processing: { bg: '#E3F2FD', color: '#1565C0' },
      reviewed: { bg: '#E8F5E9', color: '#2E7D32' },
      label_purchased: { bg: '#E1F5FE', color: '#0277BD' },
      shipped: { bg: '#E8F5E9', color: '#2E7D32' },
      in_transit: { bg: '#E8F5E9', color: '#2E7D32' },
      delivered: { bg: '#C8E6C9', color: '#1B5E20' },
      exception: { bg: '#FFEBEE', color: '#C62828' },
    };
    const { bg, color } = colors[status] || { bg: '#f3f4f6', color: '#374151' };
    return {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '12px',
      fontSize: '11px',
      fontWeight: 500,
      backgroundColor: bg,
      color: color,
    };
  };

  const emptyStyle = {
    padding: '40px',
    textAlign: 'center',
    color: '#6B7280',
  };

  const loadingStyle = {
    padding: '40px',
    textAlign: 'center',
    color: '#6B7280',
  };

  const paginationStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderTop: '1px solid #e5e7eb',
    backgroundColor: '#f9fafb',
  };

  const paginationButtonStyle = (disabled) => ({
    padding: '6px 12px',
    borderRadius: '4px',
    border: '1px solid #e5e7eb',
    backgroundColor: disabled ? '#f3f4f6' : '#fff',
    color: disabled ? '#9CA3AF' : '#374151',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '13px',
  });

  const formatCurrency = (cents) => {
    if (cents == null) return '—';
    return `$${(cents / 100).toFixed(2)}`;
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '—';
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingStyle}>Loading fulfillments...</div>
      </div>
    );
  }

  if (fulfillments.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={emptyStyle}>
          No fulfillments found. Import orders or adjust your filters.
        </div>
      </div>
    );
  }

  // Check if we have marketplace shipments (to show actions column)
  const hasMarketplaceShipments = fulfillments.some(
    (f) => f.source === 'tcgplayer' || f.source === 'ebay'
  );

  return (
    <div style={containerStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Source</th>
            <th style={thStyle}>Order #</th>
            <th style={thStyle}>Customer</th>
            <th style={thStyle}>Items</th>
            <th style={thStyle}>Value</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Tracking</th>
            <th style={thStyle}>Created</th>
            {hasMarketplaceShipments && <th style={thStyle}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {fulfillments.map((f) => (
            <tr key={f.id}>
              <td style={tdStyle}>
                <span style={sourceTagStyle(f.source)}>{f.source}</span>
              </td>
              <td style={tdStyle}>
                <strong>{f.orderNumber}</strong>
              </td>
              <td style={tdStyle}>
                {f.customerName || <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>PII Protected</span>}
              </td>
              <td style={tdStyle}>{f.itemCount}</td>
              <td style={tdStyle}>{formatCurrency(f.valueCents)}</td>
              <td style={tdStyle}>
                <span style={statusTagStyle(f.status)}>{f.status.replace('_', ' ')}</span>
              </td>
              <td style={tdStyle}>
                {f.shipping?.trackingNumber ? (
                  <a
                    href={f.shipping.trackingUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#1565C0', textDecoration: 'none' }}
                  >
                    {f.shipping.trackingNumber}
                  </a>
                ) : (
                  <span style={{ color: '#9CA3AF' }}>—</span>
                )}
              </td>
              <td style={tdStyle}>{formatDate(f.timeline?.createdAt)}</td>
              {hasMarketplaceShipments && (
                <td style={tdStyle}>
                  {(f.source === 'tcgplayer' || f.source === 'ebay') && f.sourceRef?.shipmentId ? (
                    <MarketplaceShipmentActions
                      shipment={{
                        id: f.sourceRef.shipmentId,
                        status: f.status,
                        labelUrl: f.shipping?.labelUrl,
                        trackingNumber: f.shipping?.trackingNumber,
                        itemCount: f.itemCount,
                        valueCents: f.valueCents,
                      }}
                      onOpenRatesModal={handleOpenRatesModal}
                      onStatusChange={handleStatusChange}
                    />
                  ) : (
                    <span style={{ color: '#9CA3AF' }}>—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div style={paginationStyle}>
        <span style={{ fontSize: '13px', color: '#6B7280' }}>
          Showing {offset + 1}–{Math.min(offset + limit, total)} of {total} orders
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            style={paginationButtonStyle(currentPage === 1)}
            onClick={() => onPageChange(Math.max(0, offset - limit))}
            disabled={currentPage === 1}
          >
            Previous
          </button>
          <span style={{ padding: '6px 12px', fontSize: '13px', color: '#374151' }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            style={paginationButtonStyle(currentPage >= totalPages)}
            onClick={() => onPageChange(offset + limit)}
            disabled={currentPage >= totalPages}
          >
            Next
          </button>
        </div>
      </div>

      {/* Rates Modal for marketplace shipments */}
      <RatesModal
        shipmentId={selectedShipment?.id}
        isOpen={ratesModalOpen}
        onClose={handleCloseRatesModal}
        onLabelPurchased={handleLabelPurchased}
        initialItemCount={selectedShipment?.itemCount || 1}
        initialOrderValue={selectedShipment?.valueCents || 0}
      />
    </div>
  );
}
