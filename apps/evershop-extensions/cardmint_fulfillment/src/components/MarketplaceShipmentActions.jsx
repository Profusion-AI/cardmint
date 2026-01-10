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

  const status = shipment.status;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      {/* Pending: Show "Purchase Label" button (hidden for external fulfillment) */}
      {status === 'pending' && !shipment.isExternal && (
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

      {/* Label Purchased: Show "Print Label (PDF)" + "Mark Shipped" */}
      {status === 'label_purchased' && (
        <>
          {shipment.id && (
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
                title="Print-ready 4x6 PDF for PL-60 thermal printer (prints correctly from any viewer)"
              >
                Print Label
              </a>
              {/* Secondary: PNG for GIMP editing workflow */}
              <a
                href={`/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/label/optimized`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...buttonStyle('default'),
                  textDecoration: 'none',
                  display: 'inline-block',
                  fontSize: '10px',
                  padding: '4px 8px',
                  opacity: 0.8,
                }}
                title="PNG for GIMP editing (812x1218 @ 203 DPI)"
              >
                PNG
              </a>
            </>
          )}
          <button
            style={buttonStyle('success')}
            onClick={() => updateStatus('shipped')}
            disabled={loading}
          >
            {loading ? '...' : 'Mark Shipped'}
          </button>
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
    </div>
  );
}
