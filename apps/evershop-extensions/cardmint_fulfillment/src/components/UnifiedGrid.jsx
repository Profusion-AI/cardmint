import React, { useState, useRef, useCallback } from 'react';
import RatesModal from './RatesModal.js';
import MarketplaceShipmentActions from './MarketplaceShipmentActions.js';

/**
 * Card Preview Flyout Component
 * Shows up to 3 card images side-by-side with hover-to-reveal behavior.
 */
function CardPreviewFlyout({ previewData, position, isVisible, isLoading }) {
  if (!isVisible) return null;

  const flyoutStyle = {
    position: 'fixed',
    left: position.x,
    top: position.y + 10,
    zIndex: 1000,
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
    padding: '12px',
    minWidth: '120px',
    maxWidth: '400px',
    transition: 'opacity 0.15s ease-in-out',
    opacity: isVisible ? 1 : 0,
  };

  if (isLoading) {
    return (
      <div style={flyoutStyle}>
        <div style={{ color: '#6B7280', fontSize: '12px' }}>Loading...</div>
      </div>
    );
  }

  if (!previewData || previewData.items.length === 0) {
    return (
      <div style={flyoutStyle}>
        <div style={{ color: '#6B7280', fontSize: '12px' }}>No preview available</div>
      </div>
    );
  }

  return (
    <div style={flyoutStyle}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        {previewData.items.map((item, idx) => (
          <div key={idx} style={{ textAlign: 'center', maxWidth: '120px' }}>
            {item.imageUrl ? (
              <img
                src={item.imageUrl}
                alt={item.name}
                style={{
                  width: '104px',
                  height: '146px',
                  objectFit: 'cover',
                  borderRadius: '4px',
                  border: '1px solid #e5e7eb',
                }}
              />
            ) : (
              <div
                style={{
                  width: '104px',
                  height: '146px',
                  backgroundColor: '#f3f4f6',
                  borderRadius: '4px',
                  border: '1px solid #e5e7eb',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span style={{ fontSize: '10px', color: '#9CA3AF' }}>No image</span>
              </div>
            )}
            <div
              style={{
                fontSize: '10px',
                color: '#374151',
                marginTop: '4px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '104px',
              }}
              title={item.name}
            >
              {item.name}
            </div>
            {item.quantity > 1 && (
              <div style={{ fontSize: '9px', color: '#6B7280' }}>x{item.quantity}</div>
            )}
          </div>
        ))}
        {previewData.hasMore && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 8px',
              height: '146px',
            }}
          >
            <span
              style={{
                backgroundColor: '#f3f4f6',
                color: '#6B7280',
                fontSize: '11px',
                fontWeight: 500,
                padding: '4px 8px',
                borderRadius: '12px',
              }}
            >
              +More
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

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
  onOpenImportModal,
}) {
  const [ratesModalOpen, setRatesModalOpen] = useState(false);
  const [selectedShipment, setSelectedShipment] = useState(null);
  // Customer lookup state (keyed by fulfillment id)
  const [customerData, setCustomerData] = useState({});
  const [customerLoading, setCustomerLoading] = useState({});

  // Qty hover preview state
  const [hoveredQty, setHoveredQty] = useState(null); // { fulfillmentId, source, orderId }
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });
  const [previewCache, setPreviewCache] = useState({}); // { [key]: { data, loading, error } }
  const hoverTimeoutRef = useRef(null);

  // Get preview cache key for a fulfillment
  const getPreviewKey = useCallback((f) => {
    if (f.source === 'cardmint') {
      return `cardmint:${f.sourceRef?.stripeSessionId}`;
    }
    return `marketplace:${f.sourceRef?.marketplaceOrderId}`;
  }, []);

  // Fetch preview data for a fulfillment
  const fetchPreview = useCallback(async (f) => {
    const key = getPreviewKey(f);
    if (!key || previewCache[key]?.data || previewCache[key]?.loading) return;

    // Determine API params
    let source, id;
    if (f.source === 'cardmint') {
      source = 'cardmint';
      id = f.sourceRef?.stripeSessionId;
    } else {
      source = 'marketplace';
      id = f.sourceRef?.marketplaceOrderId;
    }

    if (!id) return;

    // Mark as loading
    setPreviewCache((prev) => ({ ...prev, [key]: { loading: true, data: null, error: null } }));

    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/orders/${source}/${encodeURIComponent(id)}/preview`,
        { credentials: 'include' }
      );
      const data = await response.json();

      if (response.ok && data.ok) {
        setPreviewCache((prev) => ({
          ...prev,
          [key]: { loading: false, data: { items: data.items, hasMore: data.hasMore, totalQty: data.totalQty }, error: null },
        }));
      } else {
        setPreviewCache((prev) => ({ ...prev, [key]: { loading: false, data: null, error: data.error || 'Failed' } }));
      }
    } catch (err) {
      setPreviewCache((prev) => ({ ...prev, [key]: { loading: false, data: null, error: 'Network error' } }));
    }
  }, [getPreviewKey, previewCache]);

  // Handle Qty cell hover
  const handleQtyMouseEnter = useCallback((e, f) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverPosition({ x: rect.left, y: rect.bottom });
    setHoveredQty({ fulfillmentId: f.id });

    // Clear any existing timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }

    // Debounce the fetch slightly to avoid rapid requests
    hoverTimeoutRef.current = setTimeout(() => {
      fetchPreview(f);
    }, 100);
  }, [fetchPreview]);

  const handleQtyMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setHoveredQty(null);
  }, []);

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
    // Order List (no address yet) gets a distinct amber badge
    if (isExternal) {
      return {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '11px',
        fontWeight: 500,
        backgroundColor: '#FFF3E0',
        color: '#E65100',
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

  const getTotalCents = (f) => {
    const productCents = Number.isFinite(f?.valueCents) ? f.valueCents : null;
    const shippingCents = Number.isFinite(f?.shippingCostCents) ? f.shippingCostCents : null;
    if (productCents == null || shippingCents == null) return null;
    return productCents + shippingCents;
  };

  const isPweCandidate = (f) => {
    if (!f) return false;
    if (!Number.isFinite(f.itemCount)) return false;
    if (f.itemCount < 1 || f.itemCount > 3) return false;
    const totalCents = getTotalCents(f);
    if (totalCents == null) return false;
    return totalCents < 749;
  };

  const formatTotalCurrency = (productCents, shippingCents) => {
    if (productCents == null || shippingCents == null) return '—';
    return formatCurrency(productCents + shippingCents);
  };

  const formatOrderDateTime = (timestamp, includeTime) => {
    if (!timestamp) return '—';
    const date = new Date(timestamp * 1000);
    if (!includeTime) return date.toLocaleDateString();
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Marketplace imports use CST-normalized midnight for date-only values (UTC 06:00:00).
  // Show time only when the import provided a time-of-day (e.g., ordertimes.csv).
  const hasKnownOrderTime = (timestamp) => {
    if (!timestamp) return false;
    const date = new Date(timestamp * 1000);
    return !(date.getUTCHours() === 6 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0);
  };

  const formatProductWithShipping = (productCents, shippingCents) => {
    if (productCents == null) return '—';
    const product = formatCurrency(productCents);
    if (shippingCents == null) return product;
    return `${product} (${formatCurrency(shippingCents)})`;
  };

  const formatTrackingAndCarrier = (shipping) => {
    const trackingNumber = shipping?.trackingNumber;
    const carrier = shipping?.carrier;

    if (!trackingNumber && !carrier) return '—';

    const trackingDisplay = trackingNumber || '—';
    const carrierDisplay = carrier ? ` — ${carrier}` : '';

    if (shipping?.trackingUrl && trackingNumber) {
      return (
        <a
          href={shipping.trackingUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#1565C0', textDecoration: 'none', fontFamily: 'monospace', fontSize: '12px' }}
        >
          {trackingDisplay}
          <span style={{ fontFamily: 'inherit' }}>{carrierDisplay}</span>
        </a>
      );
    }

    return (
      <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>
        {trackingDisplay}
        <span style={{ fontFamily: 'inherit' }}>{carrierDisplay}</span>
      </span>
    );
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
            <th style={{ ...thStyle, textAlign: 'center', width: '50px' }}>Qty</th>
            <th style={thStyle}>Buyer Name</th>
            <th style={thStyle}>Order Date/Time (if known)</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Tracking Number – Carrier</th>
            <th style={thStyle}>Product Amt (shipping fee)</th>
            <th style={thStyle}>Total Amt</th>
            {hasMarketplaceShipments && <th style={thStyle}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {fulfillments.map((f) => {
            const pweCandidate = isPweCandidate(f);
            const rowStyle = pweCandidate ? { backgroundColor: '#a6a6a6' } : undefined;
            const buyerTdStyle = pweCandidate ? { ...tdStyle, color: '#E65100' } : tdStyle;
            const productTdStyle = pweCandidate ? { ...tdStyle, color: '#E65100' } : tdStyle;

            return (
              <tr key={f.id} style={rowStyle}>
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
                      NEEDS SHIPPING EXPORT
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
              <td
                style={{ ...tdStyle, textAlign: 'center', cursor: 'default', position: 'relative' }}
                onMouseEnter={(e) => handleQtyMouseEnter(e, f)}
                onMouseLeave={handleQtyMouseLeave}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color: pweCandidate ? '#E65100' : '#374151',
                  }}
                >
                  {f.itemCount ?? '—'}
                </span>
              </td>
              <td style={buyerTdStyle}>
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
                        color: customerLoading[f.id] ? '#9CA3AF' : (pweCandidate ? '#E65100' : '#1565C0'),
                        cursor: customerLoading[f.id] ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {customerLoading[f.id] ? 'Loading...' : 'View'}
                    </button>
                  )
                ) : (
                  <span style={{ color: pweCandidate ? '#E65100' : '#9CA3AF', fontStyle: 'italic' }}>PII Protected</span>
                )}
              </td>
              <td style={tdStyle}>
                {formatOrderDateTime(
                  f.timeline?.createdAt,
                  f.source === 'cardmint' || hasKnownOrderTime(f.timeline?.createdAt)
                )}
              </td>
              <td style={tdStyle}>
                {f.isExternal ? (
                  <span
                    style={statusTagStyle(f.status, true)}
                    title={
                      f.source === 'tcgplayer'
                        ? 'Missing address from TCGPlayer Order List export. Import TCGPlayer Shipping Export CSV to enable label purchase.'
                        : 'External fulfillment (label purchase disabled)'
                    }
                  >
                    {f.source === 'tcgplayer' ? 'Needs Shipping Export' : 'External'}
                  </span>
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
              <td style={tdStyle}>{formatTrackingAndCarrier(f.shipping)}</td>
              <td style={productTdStyle}>{formatProductWithShipping(f.valueCents, f.shippingCostCents)}</td>
              <td style={tdStyle}>{formatTotalCurrency(f.valueCents, f.shippingCostCents)}</td>
              {hasMarketplaceShipments && (
                <td style={tdStyle}>
                  {(f.source === 'tcgplayer' || f.source === 'ebay') && f.sourceRef?.shipmentId ? (
                    <MarketplaceShipmentActions
                      shipment={{
                        id: f.sourceRef.shipmentId,
                        source: f.source,
                        importFormat: f.importFormat,
                        status: f.status,
                        labelUrl: f.shipping?.labelUrl,
                        trackingNumber: f.shipping?.trackingNumber,
                        itemCount: f.itemCount,
                        valueCents: f.valueCents,
                        shippingCostCents: f.shippingCostCents,
                        isPwe: !!f.isPwe,
                        isExternal: f.isExternal,
                        // Refund tracking fields
                        labelViewedAt: f.shipping?.labelViewedAt,
                        refundStatus: f.refundStatus,
                        easypostShipmentId: f.easypostShipmentId,
                      }}
                      onOpenRatesModal={handleOpenRatesModal}
                      onStatusChange={handleStatusChange}
                      onOpenImportModal={onOpenImportModal}
                    />
                  ) : (
                    <span style={{ color: '#9CA3AF' }}>—</span>
                  )}
                </td>
              )}
              </tr>
            );
          })}
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

      {/* Qty hover preview flyout */}
      {hoveredQty && (() => {
        const f = fulfillments.find((item) => item.id === hoveredQty.fulfillmentId);
        if (!f) return null;
        const key = getPreviewKey(f);
        const cacheEntry = previewCache[key];
        return (
          <CardPreviewFlyout
            previewData={cacheEntry?.data}
            position={hoverPosition}
            isVisible={!!hoveredQty}
            isLoading={cacheEntry?.loading}
          />
        );
      })()}
    </div>
  );
}
