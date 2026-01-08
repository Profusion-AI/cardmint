import React, { useState } from 'react';
import RatesModal from './RatesModal.js';
import MarketplaceShipmentActions from './MarketplaceShipmentActions.js';

/**
 * Unified Fulfillment Grid Component
 *
 * Displays fulfillments from all sources in a unified table format.
 * Supports pagination and shows source-specific details.
 * Includes action buttons for marketplace shipments (Phase 4).
 * Customer lookup for CardMint orders (on-demand PII from Stripe).
 */
export default function UnifiedGrid({
  fulfillments = [],
  loading = false,
  total = 0,
  limit = 20,
  offset = 0,
  onPageChange,
  onRefresh,
  onOrderClick,
}) {
  const [ratesModalOpen, setRatesModalOpen] = useState(false);
  const [selectedShipment, setSelectedShipment] = useState(null);
  // Customer lookup state (keyed by fulfillment id)
  const [customerData, setCustomerData] = useState({});
  const [customerLoading, setCustomerLoading] = useState({});

  // Fetch customer details from Stripe via backend
  const handleLookupCustomer = async (fulfillmentId, stripeSessionId) => {
    if (customerData[fulfillmentId] || customerLoading[fulfillmentId]) return;

    setCustomerLoading((prev) => ({ ...prev, [fulfillmentId]: true }));
    try {
      const response = await fetch(`/api/admin/api/fulfillment/stripe/${stripeSessionId}/customer`, {
        credentials: 'include',
      });
      const data = await response.json();
      if (data.ok) {
        setCustomerData((prev) => ({ ...prev, [fulfillmentId]: data }));
      } else {
        setCustomerData((prev) => ({ ...prev, [fulfillmentId]: { error: data.error || 'Failed to load' } }));
      }
    } catch (err) {
      setCustomerData((prev) => ({ ...prev, [fulfillmentId]: { error: 'Network error' } }));
    } finally {
      setCustomerLoading((prev) => ({ ...prev, [fulfillmentId]: false }));
    }
  };

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

  const statusTagStyle = (status, isExternal = false) => {
    // External fulfillment gets a distinct neutral gray badge
    if (isExternal) {
      return {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '11px',
        fontWeight: 500,
        backgroundColor: '#E5E7EB',
        color: '#6B7280',
      };
    }

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

  const formatTotalCurrency = (productCents, shippingCents) => {
    if (productCents == null || shippingCents == null) return '—';
    return formatCurrency(productCents + shippingCents);
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '—';
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  const getOrderDetailsUrl = (f) => {
    if (!f) return null;

    if (f.source === 'cardmint') {
      const sessionId = f.sourceRef?.stripeSessionId;
      if (!sessionId) return null;
      return `/admin/fulfillment/orders/cardmint/${encodeURIComponent(sessionId)}`;
    }

    // Marketplace drill-in is order-based (not shipment-based)
    const orderId = f.sourceRef?.marketplaceOrderId;
    if (!orderId) return null;
    return `/admin/fulfillment/orders/marketplace/${orderId}`;
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
            <th style={thStyle}>Order #</th>
            <th style={thStyle}>Buyer Name</th>
            <th style={thStyle}>Order Date</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Shipping Type</th>
            <th style={thStyle}>Product Amt</th>
            <th style={thStyle}>Shipping Amt</th>
            <th style={thStyle}>Total Amt</th>
            {hasMarketplaceShipments && <th style={thStyle}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {fulfillments.map((f) => (
            <tr key={f.id}>
              <td style={tdStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={sourceTagStyle(f.source)}>{f.source}</span>
                  {f.isExternal && (
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 600,
                      backgroundColor: '#FFF3E0',
                      color: '#E65100',
                      border: '1px solid #FFB74D',
                    }}>
                      EXTERNAL
                    </span>
                  )}
                </div>
                <div style={{ marginTop: '4px' }}>
                  {(() => {
                    const detailsUrl = getOrderDetailsUrl(f);
                    const linkStyle = { color: '#1565C0', textDecoration: 'none', fontWeight: 600 };

                    if (f.orderNumber?.startsWith('Session:')) {
                      const display = f.orderNumber.replace('Session: ', '#');
                      return detailsUrl ? (
                        <a
                          href={detailsUrl}
                          onClick={() => onOrderClick?.()}
                          style={{ ...linkStyle, fontFamily: 'monospace', fontSize: '12px' }}
                        >
                          {display}
                        </a>
                      ) : (
                        <strong style={{ fontFamily: 'monospace', fontSize: '12px' }}>{display}</strong>
                      );
                    }

                    const display = f.orderNumber || '—';
                    return detailsUrl ? (
                      <a
                        href={detailsUrl}
                        onClick={() => onOrderClick?.()}
                        style={linkStyle}
                      >
                        {display}
                      </a>
                    ) : (
                      <strong>{display}</strong>
                    );
                  })()}
                </div>
              </td>
              <td style={tdStyle}>
                {f.customerName ? (
                  f.customerName
                ) : f.source === 'cardmint' && f.sourceRef?.stripeSessionId ? (
                  customerData[f.id] ? (
                    customerData[f.id].error ? (
                      <span style={{ color: '#C62828', fontSize: '11px' }}>{customerData[f.id].error}</span>
                    ) : (
                      <div style={{ fontSize: '12px', lineHeight: '1.4' }}>
                        <div style={{ fontWeight: 500 }}>{customerData[f.id].customerName || '—'}</div>
                      </div>
                    )
                  ) : (
                    <button
                      onClick={() => handleLookupCustomer(f.id, f.sourceRef.stripeSessionId)}
                      disabled={customerLoading[f.id]}
                      style={{
                        padding: '2px 8px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid #e5e7eb',
                        backgroundColor: customerLoading[f.id] ? '#f3f4f6' : '#fff',
                        color: customerLoading[f.id] ? '#9CA3AF' : '#1565C0',
                        cursor: customerLoading[f.id] ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {customerLoading[f.id] ? 'Loading...' : 'View'}
                    </button>
                  )
                ) : (
                  <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>PII Protected</span>
                )}
              </td>
              <td style={tdStyle}>{formatDate(f.timeline?.createdAt)}</td>
              <td style={tdStyle}>
                {f.isExternal ? (
                  <span style={statusTagStyle(f.status, true)}>External</span>
                ) : (
                  <span style={statusTagStyle(f.status)}>{f.status.replace('_', ' ')}</span>
                )}
                {f.exception && (
                  <div style={{ marginTop: '4px', fontSize: '11px', color: '#6B7280', maxWidth: '180px' }}>
                    <div style={{ fontWeight: 500, color: '#C62828' }}>{f.exception.type?.replace(/_/g, ' ')}</div>
                    {f.exception.notes && (
                      <div style={{ marginTop: '2px', lineHeight: '1.3', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {f.exception.notes.length > 80 ? `${f.exception.notes.slice(0, 80)}…` : f.exception.notes}
                      </div>
                    )}
                  </div>
                )}
              </td>
              <td style={tdStyle}>
                {f.shippingMethod || <span style={{ color: '#9CA3AF' }}>—</span>}
              </td>
              <td style={tdStyle}>{formatCurrency(f.valueCents)}</td>
              <td style={tdStyle}>{formatCurrency(f.shippingCostCents)}</td>
              <td style={tdStyle}>{formatTotalCurrency(f.valueCents, f.shippingCostCents)}</td>
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
                        isExternal: f.isExternal,
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
