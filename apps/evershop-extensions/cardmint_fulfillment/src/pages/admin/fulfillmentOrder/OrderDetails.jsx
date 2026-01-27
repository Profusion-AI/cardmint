import React, { useEffect, useMemo, useState } from 'react';

function formatCurrency(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function formatStatusLabel(status) {
  if (!status) return '—';
  return String(status).replace(/_/g, ' ');
}

function safeCopy(text) {
  if (!text) return;
  try {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // ignore
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  } catch {
    // ignore
  }
}

function buildTrackingUrl(trackingNumber, carrier, trackingUrl) {
  if (trackingUrl) return trackingUrl;
  if (!trackingNumber || !carrier) return null;
  const c = String(carrier).toLowerCase();
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  return null;
}

function normalizeAddress(address) {
  if (!address) return null;

  // CardMint/Stripe shape
  if (address.line1 || address.postalCode) {
    return {
      name: null,
      line1: address.line1 || '',
      line2: address.line2 || '',
      city: address.city || '',
      state: address.state || '',
      postalCode: address.postalCode || '',
      country: address.country || '',
    };
  }

  // Marketplace shape
  if (address.street1 || address.zip) {
    return {
      name: address.name || null,
      line1: address.street1 || '',
      line2: address.street2 || '',
      city: address.city || '',
      state: address.state || '',
      postalCode: address.zip || '',
      country: address.country || '',
    };
  }

  return null;
}

/**
 * Price source badge component for market estimate column.
 */
function PriceSourceBadge({ source }) {
  const styles = {
    ppt: { label: 'PPT', bg: '#DBEAFE', color: '#1D4ED8' },
    tcgdex: { label: 'TCGD', bg: '#FEF3C7', color: '#92400E' },
    unavailable: { label: '—', bg: '#F3F4F6', color: '#6B7280' },
  };

  const style = styles[source] || styles.unavailable;

  if (source === 'unavailable') {
    return <span style={{ color: style.color }}>—</span>;
  }

  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '10px',
        backgroundColor: style.bg,
        color: style.color,
        padding: '2px 6px',
        borderRadius: '4px',
        fontWeight: 600,
        marginLeft: '4px',
      }}
    >
      {style.label}
    </span>
  );
}

/**
 * Image flyout component for hover preview.
 */
function ImageFlyout({ imageUrl, position, isVisible }) {
  if (!isVisible || !imageUrl) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: Math.min(position.x + 20, window.innerWidth - 220),
        top: Math.min(position.y - 100, window.innerHeight - 300),
        zIndex: 1000,
        backgroundColor: '#fff',
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
        borderRadius: '8px',
        padding: '8px',
        border: '1px solid #e5e7eb',
        opacity: isVisible ? 1 : 0,
        transition: 'opacity 0.15s ease-in-out',
        pointerEvents: 'none',
      }}
    >
      <img
        src={imageUrl}
        alt="Card preview"
        style={{
          maxWidth: '200px',
          maxHeight: '280px',
          borderRadius: '4px',
          display: 'block',
        }}
      />
    </div>
  );
}

export default function OrderDetails() {
  const [params, setParams] = useState({ source: null, id: null });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Image preview state
  const [revealedImages, setRevealedImages] = useState(new Set());
  const [hoveredImage, setHoveredImage] = useState({ url: null, position: { x: 0, y: 0 } });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parts = window.location.pathname.split('/').filter(Boolean);
    const source = parts[3] || null;
    const id = parts[4] ? decodeURIComponent(parts.slice(4).join('/')) : null;
    setParams({ source, id });
  }, []);

  useEffect(() => {
    const { source, id } = params;
    if (!source || !id) return;

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        // Request enrichment with market pricing + images
        const resp = await fetch(
          `/api/admin/api/fulfillment/orders/${encodeURIComponent(source)}/${encodeURIComponent(id)}?enrich=true`,
          { credentials: 'include' }
        );
        const json = await resp.json();
        if (!resp.ok || !json.ok) {
          throw new Error(json.message || json.error || `HTTP ${resp.status}`);
        }
        if (!cancelled) {
          setData(json);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || 'Failed to load order');
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params]);

  const order = data?.order || {};
  const buyer = data?.buyer || {};
  const shipping = data?.shipping || {};
  const items = Array.isArray(data?.items) ? data.items : [];
  const shipments = Array.isArray(data?.shipments) ? data.shipments : [];

  const address = useMemo(() => normalizeAddress(shipping.address), [shipping.address]);
  const addressSingleLine = useMemo(() => {
    if (!address) return null;
    const parts = [
      address.name,
      address.line1,
      address.line2,
      `${address.city}${address.city && address.state ? ', ' : ''}${address.state} ${address.postalCode}`.trim(),
      address.country,
    ].filter(Boolean);
    return parts.join(', ');
  }, [address]);

  const hasAnyShipmentData = shipments.some((s) => s?.trackingNumber || s?.labelUrl);

  // Find shipment with a label for the Print Label button
  const shipmentWithLabel = useMemo(() => {
    return shipments.find((s) => s?.labelUrl || s?.labelPurchasedAt);
  }, [shipments]);

  const shipmentProvenance = useMemo(() => {
    if (shipments.some((s) => s?.provenance === 'easypost_label')) return 'EasyPost label';
    if (shipments.some((s) => s?.provenance === 'csv_upload')) return 'CSV upload';
    return 'none';
  }, [shipments]);

  // Check if any items have enriched pricing data
  const hasEnrichedData = useMemo(() => {
    return items.some((it) => it.priceSource && it.priceSource !== 'unavailable');
  }, [items]);

  // Handle image reveal click
  const handleRevealImage = (idx) => {
    setRevealedImages((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Handle mouse move for image flyout
  const handleMouseMove = (e, imageUrl) => {
    if (imageUrl) {
      setHoveredImage({ url: imageUrl, position: { x: e.clientX, y: e.clientY } });
    }
  };

  const handleMouseLeave = () => {
    setHoveredImage({ url: null, position: { x: 0, y: 0 } });
  };

  // Styles
  const containerStyle = {
    padding: '20px',
    maxWidth: '1200px',
    margin: '0 auto',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '16px',
    marginBottom: '16px',
  };

  const titleStyle = {
    fontSize: '24px',
    fontWeight: 700,
    color: '#0A203F',
    margin: 0,
  };

  const subtitleStyle = {
    fontSize: '13px',
    color: '#6B7280',
    marginTop: '6px',
  };

  const buttonStyle = {
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    backgroundColor: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    color: '#374151',
  };

  const printLabelButtonStyle = {
    padding: '8px 12px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: '#2563EB',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    color: '#fff',
    textDecoration: 'none',
    display: 'inline-block',
  };

  const sectionStyle = {
    backgroundColor: '#fff',
    borderRadius: '10px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    padding: '16px',
    marginTop: '16px',
  };

  const sectionTitleStyle = {
    fontSize: '14px',
    fontWeight: 700,
    color: '#0A203F',
    margin: 0,
    marginBottom: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  };

  const rowStyle = {
    display: 'grid',
    gridTemplateColumns: '180px 1fr',
    gap: '10px',
    padding: '6px 0',
    borderBottom: '1px solid #f3f4f6',
  };

  const labelStyle = {
    color: '#6B7280',
    fontSize: '13px',
  };

  const valueStyle = {
    color: '#111827',
    fontSize: '13px',
    fontWeight: 500,
    wordBreak: 'break-word',
  };

  const tableStyle = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  };

  const thStyle = {
    textAlign: 'left',
    padding: '10px 8px',
    borderBottom: '1px solid #e5e7eb',
    color: '#374151',
    fontSize: '12px',
    textTransform: 'uppercase',
  };

  const tdStyle = {
    padding: '10px 8px',
    borderBottom: '1px solid #f3f4f6',
    verticalAlign: 'top',
    color: '#111827',
  };

  const emptyStyle = {
    padding: '12px',
    backgroundColor: '#f9fafb',
    borderRadius: '8px',
    color: '#6B7280',
    fontSize: '13px',
  };

  const clickableNameStyle = {
    cursor: 'pointer',
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
    textDecorationColor: '#9CA3AF',
    textUnderlineOffset: '2px',
  };

  const back = () => {
    try {
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
    } catch {
      // ignore
    }
    window.location.href = '/admin/fulfillment';
  };

  return (
    <div style={containerStyle}>
      {/* Image flyout on hover */}
      <ImageFlyout
        imageUrl={hoveredImage.url}
        position={hoveredImage.position}
        isVisible={!!hoveredImage.url}
      />

      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>
            Order {order.orderNumber || '—'}
          </h1>
          <div style={subtitleStyle}>
            Status: <strong>{formatStatusLabel(order.status)}</strong>
            {' • '}
            Order Date: <strong>{formatDateTime(order.orderDate)}</strong>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {shipmentWithLabel && shipmentWithLabel.id && (
            <a
              href={`/api/admin/api/fulfillment/marketplace/shipments/${shipmentWithLabel.id}/label/optimized?format=pdf`}
              target="_blank"
              rel="noopener noreferrer"
              style={printLabelButtonStyle}
              title="Print-ready 4x6 PDF for thermal printer"
            >
              Print Label
            </a>
          )}
          <button style={buttonStyle} onClick={back}>Back</button>
          <button style={buttonStyle} onClick={() => safeCopy(order.orderNumber || '')}>Copy Order #</button>
          {addressSingleLine && (
            <button style={buttonStyle} onClick={() => safeCopy(addressSingleLine)}>Copy Address</button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px', backgroundColor: '#FFEBEE', borderRadius: '8px', color: '#C62828' }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={emptyStyle}>Loading order...</div>
      )}

      {!loading && !error && (
        <>
          {/* A) Order Summary */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Order Summary</div>
            <div style={rowStyle}>
              <div style={labelStyle}>Order Number</div>
              <div style={valueStyle}>{order.orderNumber || '—'}</div>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Status</div>
              <div style={valueStyle}>{formatStatusLabel(order.status)}</div>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Order Date</div>
              <div style={valueStyle}>{formatDateTime(order.orderDate)}</div>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Updated At</div>
              <div style={valueStyle}>{formatDateTime(order.updatedAt)}</div>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Payment Method</div>
              <div style={valueStyle}>{order.paymentMethod || '—'}</div>
            </div>
            <div style={{ ...rowStyle, borderBottom: 'none' }}>
              <div style={labelStyle}>Totals</div>
              <div style={valueStyle}>
                <div>Product: {formatCurrency(order.totals?.productCents)}</div>
                <div>Shipping: {formatCurrency(order.totals?.shippingCents)}</div>
                {order.totals?.discountCents ? <div>Discounts: -{formatCurrency(order.totals.discountCents)}</div> : null}
                {order.totals?.taxCents ? <div>Tax: {formatCurrency(order.totals.taxCents)}</div> : null}
                <div style={{ marginTop: '6px', fontWeight: 700 }}>
                  Total: {formatCurrency(order.totals?.totalCents)}
                </div>
              </div>
            </div>
          </div>

          {/* B) Items */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Items</div>
            {items.length === 0 ? (
              <div style={emptyStyle}>No line items available.</div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Item</th>
                    <th style={thStyle}>Set / #</th>
                    <th style={thStyle}>Condition</th>
                    <th style={thStyle}>SKU</th>
                    <th style={thStyle}>Qty</th>
                    <th style={thStyle}>Unit</th>
                    <th style={thStyle}>Total</th>
                    <th style={thStyle}>Market Est.</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => {
                    // Check if this is real card data (has setName/condition) vs placeholder
                    const hasCardData = !!it.setName || !!it.condition || !!it.cardNumber;
                    const setDisplay = hasCardData
                      ? [it.setName, it.cardNumber].filter(Boolean).join(' / ') || '—'
                      : '—';
                    const conditionDisplay = it.condition || '—';

                    // Price confidence badge
                    const priceConfidence = it.priceConfidence;
                    const isEstimated = priceConfidence === 'estimated';

                    // Get the best image URL (prefer enriched cardImageUrl over original imageUrl)
                    const bestImageUrl = it.cardImageUrl || it.imageUrl;
                    const isImageRevealed = revealedImages.has(idx);

                    return (
                      <tr key={idx}>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            {/* Show thumbnail if revealed */}
                            {isImageRevealed && bestImageUrl && (
                              <img
                                src={bestImageUrl}
                                alt=""
                                style={{
                                  width: '36px',
                                  height: '50px',
                                  borderRadius: '4px',
                                  objectFit: 'cover',
                                  border: '1px solid #e5e7eb',
                                  cursor: 'pointer',
                                }}
                                onMouseMove={(e) => handleMouseMove(e, bestImageUrl)}
                                onMouseLeave={handleMouseLeave}
                                onClick={() => handleRevealImage(idx)}
                              />
                            )}
                            <div>
                              <div
                                style={{
                                  fontWeight: 600,
                                  ...(bestImageUrl ? clickableNameStyle : {}),
                                }}
                                onClick={bestImageUrl ? () => handleRevealImage(idx) : undefined}
                                onMouseMove={bestImageUrl ? (e) => handleMouseMove(e, bestImageUrl) : undefined}
                                onMouseLeave={bestImageUrl ? handleMouseLeave : undefined}
                                title={bestImageUrl ? (isImageRevealed ? 'Click to hide image' : 'Click to show image') : undefined}
                              >
                                {it.title || '—'}
                              </div>
                              {it.productLine && (
                                <div style={{ fontSize: '11px', color: '#6B7280' }}>{it.productLine}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <span style={{ fontSize: '12px' }}>{setDisplay}</span>
                        </td>
                        <td style={tdStyle}>
                          <span style={{ fontSize: '12px' }}>{conditionDisplay}</span>
                        </td>
                        <td style={tdStyle} title={it.sku || ''}>
                          <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{it.sku || '—'}</span>
                        </td>
                        <td style={tdStyle}>{it.quantity ?? 1}</td>
                        <td style={tdStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            {formatCurrency(it.unitPriceCents)}
                            {isEstimated && (
                              <span
                                title="Estimated price (multi-item order)"
                                style={{
                                  display: 'inline-block',
                                  fontSize: '10px',
                                  backgroundColor: '#FEF3C7',
                                  color: '#92400E',
                                  padding: '1px 4px',
                                  borderRadius: '4px',
                                  fontWeight: 600,
                                }}
                              >
                                ~
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={tdStyle}>{formatCurrency(it.lineTotalCents)}</td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span title={it.priceLabel || undefined}>
                              {formatCurrency(it.derivedUnitPriceCents)}
                            </span>
                            <PriceSourceBadge source={it.priceSource || 'unavailable'} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* C) Buyer + Shipping */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Buyer + Shipping</div>
            <div style={rowStyle}>
              <div style={labelStyle}>Buyer Name</div>
              <div style={valueStyle}>{buyer.name || '—'}</div>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Buyer Email</div>
              <div style={valueStyle}>{buyer.email || '—'}</div>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Shipping Type</div>
              <div style={valueStyle}>{shipping.shippingType || '—'}</div>
            </div>
            <div style={{ ...rowStyle, borderBottom: 'none' }}>
              <div style={labelStyle}>Shipping Address</div>
              <div style={valueStyle}>
                {shipping.addressAvailable ? (
                  <>
                    {address?.name ? <div style={{ fontWeight: 700 }}>{address.name}</div> : null}
                    <div>{address?.line1}</div>
                    {address?.line2 ? <div>{address.line2}</div> : null}
                    <div>
                      {address?.city}{address?.city && address?.state ? ', ' : ''}{address?.state}{' '}
                      {address?.postalCode}
                    </div>
                    <div>{address?.country}</div>
                  </>
                ) : (
                  <div style={emptyStyle}>
                    Address not yet available.
                    {shipping.addressReason ? ` ${shipping.addressReason}` : ''}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* D) Shipment / Tracking */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Shipment / Tracking</div>
            <div style={{ marginBottom: '10px', color: '#6B7280', fontSize: '13px' }}>
              Source: <strong>{shipmentProvenance}</strong>
            </div>
            {!hasAnyShipmentData ? (
              <div style={emptyStyle}>No label/tracking on file yet.</div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Tracking</th>
                    <th style={thStyle}>Carrier / Service</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Label Purchased</th>
                  </tr>
                </thead>
                <tbody>
                  {shipments.map((s, idx) => {
                    const trackingUrl = buildTrackingUrl(s.trackingNumber, s.carrier, s.trackingUrl);
                    return (
                      <tr key={idx}>
                        <td style={tdStyle}>
                          {s.trackingNumber ? (
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{s.trackingNumber}</span>
                              <button style={buttonStyle} onClick={() => safeCopy(s.trackingNumber)}>Copy</button>
                              {trackingUrl ? (
                                <a href={trackingUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#1565C0', textDecoration: 'none' }}>
                                  Track
                                </a>
                              ) : null}
                            </div>
                          ) : (
                            <span style={{ color: '#9CA3AF' }}>—</span>
                          )}
                        </td>
                        <td style={tdStyle}>
                          <div>{s.carrier || '—'}</div>
                          <div style={{ color: '#6B7280' }}>{s.service || '—'}</div>
                        </td>
                        <td style={tdStyle}>{formatStatusLabel(s.status)}</td>
                        <td style={tdStyle}>{formatDateTime(s.labelPurchasedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export const layout = {
  areaId: 'content',
  sortOrder: 11,
};
