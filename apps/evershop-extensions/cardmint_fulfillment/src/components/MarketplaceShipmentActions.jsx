import React, { useState } from 'react';

/**
 * MarketplaceShipmentActions Component
 *
 * Action buttons for marketplace shipments based on current status.
 * - pending: "Purchase Label" button (opens rates modal)
 * - label_purchased: "Download Label" + "Mark Shipped" buttons
 * - shipped: "Mark Delivered" button
 */
export default function MarketplaceShipmentActions({
  shipment,
  onOpenRatesModal,
  onStatusChange,
  onOpenImportModal,
}) {
  const [loading, setLoading] = useState(false);
  const pweThresholdCents = 749;

  const buttonStyle = (variant = 'default') => {
    const variants = {
      default: {
        backgroundColor: '#fff',
        color: '#374151',
        border: '1px solid #e5e7eb',
      },
      primary: {
        backgroundColor: '#2563EB',
        color: '#fff',
        border: 'none',
      },
      success: {
        backgroundColor: '#059669',
        color: '#fff',
        border: 'none',
      },
      warning: {
        backgroundColor: '#D97706',
        color: '#fff',
        border: 'none',
      },
    };
    return {
      padding: '6px 12px',
      borderRadius: '4px',
      fontSize: '12px',
      fontWeight: 500,
      cursor: 'pointer',
      marginRight: '6px',
      ...variants[variant],
    };
  };

  const formatCurrency = (cents) => {
    if (!Number.isFinite(cents)) return '—';
    return `$${(cents / 100).toFixed(2)}`;
  };

  const updateStatus = async (newStatus, notes = '') => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus, notes }),
          credentials: 'include',
        }
      );

      const data = await response.json();

      if (data.ok && onStatusChange) {
        onStatusChange(shipment.id, newStatus);
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    } finally {
      setLoading(false);
    }
  };

  const updatePwe = async (isPwe) => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/pwe`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPwe }),
          credentials: 'include',
        }
      );

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.message || data.error || 'Failed to update PWE');
      }

      if (onStatusChange) {
        onStatusChange(shipment.id, shipment.status);
      }
    } catch (err) {
      window.alert(err?.message || 'Failed to update PWE');
    } finally {
      setLoading(false);
    }
  };

  const handleRefund = async () => {
    const confirmed = window.confirm(
      `Request label refund for shipment #${shipment.id}?\n\n` +
      `Tracking: ${shipment.trackingNumber || 'N/A'}\n\n` +
      `USPS refunds require:\n` +
      `• Label created within 30 days\n` +
      `• Package NOT scanned by USPS\n\n` +
      `Proceed with refund request?`
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/refund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        }
      );
      const data = await response.json();

      if (data.ok) {
        window.alert(`Refund ${data.refundStatus}: ${
          data.refundStatus === 'refunded' ? 'Label refunded immediately' :
          data.refundStatus === 'submitted' ? 'Refund submitted for processing (may take up to 15 days)' :
          'Refund rejected - label may have been scanned'
        }`);
        if (onStatusChange) onStatusChange(shipment.id, shipment.status);
      } else {
        window.alert(`Refund failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      window.alert(`Refund failed: ${err.message || 'Network error'}`);
    } finally {
      setLoading(false);
    }
  };

  const status = shipment.status;
  const itemCount = Number.isFinite(shipment.itemCount) ? shipment.itemCount : null;
  const valueCents = Number.isFinite(shipment.valueCents) ? shipment.valueCents : null;
  const shippingCents = Number.isFinite(shipment.shippingCostCents) ? shipment.shippingCostCents : null;
  const totalCents = valueCents != null && shippingCents != null ? valueCents + shippingCents : null;
  const isPweCandidate =
    itemCount != null &&
    itemCount >= 1 &&
    itemCount <= 3 &&
    totalCents != null &&
    totalCents < pweThresholdCents;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      {shipment.isPwe && (
        <span
          style={{
            padding: '4px 8px',
            backgroundColor: '#E0E0E0',
            color: '#111827',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 700,
            border: '1px solid #D1D5DB',
          }}
          title="PWE: Plain White Envelope / stamp-based manual shipping (no tracking)"
        >
          PWE
        </span>
      )}

      {/* Pending: Show "Purchase Label" button (hidden for external fulfillment) */}
      {status === 'pending' && !shipment.isExternal && !shipment.isPwe && (
        <button
          style={buttonStyle('primary')}
          onClick={() => onOpenRatesModal(shipment)}
          disabled={loading}
          title="View shipping rates and purchase a label"
        >
          Purchase Label
        </button>
      )}

      {/* Order List import (no address): Prompt for Shipping Export upload */}
      {status === 'pending' && shipment.isExternal && (
        <>
          <span
            style={{
              padding: '4px 8px',
              backgroundColor: '#FFF3E0',
              color: '#E65100',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              border: '1px solid #FFB74D',
            }}
            title={
              shipment.source === 'tcgplayer' || shipment.importFormat === 'orderlist'
                ? 'This order came from a TCGPlayer Order List export (no shipping address). Import the TCGPlayer Shipping Export CSV to add the address and enable label purchase.'
                : 'External fulfillment (label purchase disabled)'
            }
          >
            Needs Shipping Export
          </span>
          {onOpenImportModal && (
            <button
              style={buttonStyle('warning')}
              onClick={() => onOpenImportModal()}
              disabled={loading}
              title="Open CSV importer (upload TCGPlayer Shipping Export)"
            >
              Import Shipping Export
            </button>
          )}
        </>
      )}

      {/* Label Purchased: Show "Print/Reprint Label (PDF)" + "Refund" + "Mark Shipped" */}
      {status === 'label_purchased' && (
        <>
          {shipment.id && (!shipment.refundStatus || shipment.refundStatus === 'rejected') && (
            <>
              {/* Primary: Print-ready PDF - works with Fedora's native viewer */}
              <a
                href={`/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/label/optimized?format=pdf`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...buttonStyle('primary'),
                  textDecoration: 'none',
                  display: 'inline-block',
                }}
                title={shipment.labelViewedAt
                  ? "Reprint label (already printed once)"
                  : "Print-ready 4x6 PDF for PL-60 thermal printer"}
              >
                {shipment.labelViewedAt ? 'Reprint' : 'Print Label'}
              </a>
              {/* Refund button (replaces PNG) */}
              {shipment.easypostShipmentId && (
                <button
                  style={buttonStyle('warning')}
                  onClick={handleRefund}
                  disabled={loading}
                  title="Request label refund via EasyPost (USPS: within 30 days, not scanned)"
                >
                  {loading ? '...' : 'Refund'}
                </button>
              )}
            </>
          )}
          {/* Refund status badge */}
          {shipment.refundStatus && (
            <span style={{
              padding: '4px 8px',
              backgroundColor: shipment.refundStatus === 'refunded' ? '#D1FAE5' :
                               shipment.refundStatus === 'rejected' ? '#FEE2E2' : '#FEF3C7',
              color: shipment.refundStatus === 'refunded' ? '#065F46' :
                     shipment.refundStatus === 'rejected' ? '#991B1B' : '#92400E',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500,
            }}>
              {shipment.refundStatus === 'submitted' ? 'Refund Pending' :
               shipment.refundStatus === 'refunded' ? 'Refunded' : 'Refund Rejected'}
            </span>
          )}
          {(!shipment.refundStatus || shipment.refundStatus === 'rejected') && (
            <button
              style={buttonStyle('success')}
              onClick={() => updateStatus('shipped')}
              disabled={loading}
            >
              {loading ? '...' : 'Mark Shipped'}
            </button>
          )}
        </>
      )}

      {/* Shipped: Show "Mark Delivered" */}
      {status === 'shipped' && (
        <button
          style={buttonStyle('success')}
          onClick={() => updateStatus('delivered')}
          disabled={loading}
        >
          {loading ? '...' : 'Mark Delivered'}
        </button>
      )}

      {/* In Transit: Show "Mark Delivered" */}
      {status === 'in_transit' && (
        <button
          style={buttonStyle('success')}
          onClick={() => updateStatus('delivered')}
          disabled={loading}
        >
          {loading ? '...' : 'Mark Delivered'}
        </button>
      )}

      {/* Exception: Show status indicator */}
      {status === 'exception' && (
        <span
          style={{
            padding: '4px 8px',
            backgroundColor: '#FEE2E2',
            color: '#991B1B',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 500,
          }}
        >
          Exception
        </span>
      )}

      {/* Delivered: Show completed indicator */}
      {status === 'delivered' && (
        <span
          style={{
            padding: '4px 8px',
            backgroundColor: '#D1FAE5',
            color: '#065F46',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 500,
          }}
        >
          Completed
        </span>
      )}

      {/* PWE Toggle (marketplace shipments) */}
      {shipment.isPwe ? (
        <button
          style={buttonStyle('default')}
          onClick={() => {
            const confirmed = window.confirm(
              'Undo PWE?\n\nThis re-enables tracked label purchase for this shipment.'
            );
            if (!confirmed) return;
            updatePwe(false);
          }}
          disabled={loading}
          title="Undo PWE (re-enable label purchase)"
        >
          {loading ? '...' : 'Undo PWE'}
        </button>
      ) : (
        <button
          style={buttonStyle('warning')}
          onClick={() => {
            const summaryParts = [];
            if (totalCents != null) summaryParts.push(`Order total: ${formatCurrency(totalCents)}`);
            if (itemCount != null) summaryParts.push(`Cards: ${itemCount}`);
            const summary = summaryParts.length > 0 ? `\n\n${summaryParts.join(' • ')}` : '';

            const warning = isPweCandidate
              ? ''
              : '\n\nWARNING: This order does not meet the PWE threshold (1–3 cards and total < $7.49).';

            const confirmed = window.confirm(
              `Mark as PWE (Plain White Envelope / stamp)?${warning}\n\nThis disables label purchase until you undo it.${summary}`
            );
            if (!confirmed) return;
            updatePwe(true);
          }}
          disabled={loading}
          title="Mark as PWE (stamp-based manual shipping; disables label purchase)"
        >
          {loading ? '...' : 'Mark PWE'}
        </button>
      )}
    </div>
  );
}
