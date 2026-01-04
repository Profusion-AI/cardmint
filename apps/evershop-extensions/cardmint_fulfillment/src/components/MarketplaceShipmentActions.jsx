import React, { useState } from 'react';

/**
 * MarketplaceShipmentActions Component
 *
 * Action buttons for marketplace shipments based on current status.
 * - pending: "Get Rates" button
 * - label_purchased: "Download Label" + "Mark Shipped" buttons
 * - shipped: "Mark Delivered" button
 */
export default function MarketplaceShipmentActions({
  shipment,
  onOpenRatesModal,
  onStatusChange,
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
        `/admin/api/fulfillment/marketplace/shipments/${shipment.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus, notes }),
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
      {/* Pending: Show "Get Rates" button */}
      {status === 'pending' && (
        <button
          style={buttonStyle('primary')}
          onClick={() => onOpenRatesModal(shipment)}
          disabled={loading}
        >
          Get Rates
        </button>
      )}

      {/* Label Purchased: Show "Download Label" + "Mark Shipped" */}
      {status === 'label_purchased' && (
        <>
          {shipment.labelUrl && (
            <a
              href={shipment.labelUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...buttonStyle('default'),
                textDecoration: 'none',
                display: 'inline-block',
              }}
            >
              Download Label
            </a>
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
