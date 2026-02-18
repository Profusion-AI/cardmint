import React, { useEffect, useRef, useState } from 'react';

/**
 * MarketplaceShipmentActions Component
 *
 * Intelligent actions dropdown for marketplace shipments based on current status.
 * Replaces button stack with dropdown + staged confirm for cleaner UX.
 *
 * Action eligibility rules:
 * - Purchase Label: status=pending, !isExternal, !isPwe, !labelActionsDisabled
 * - Import Shipping Export: status=pending, isExternal
 * - Mark PWE / Undo PWE: status=pending OR status=label_purchased
 * - Combine with...: status=pending, !labelActionsDisabled
 * - Print Label: status=label_purchased, !refundStatus
 * - Refund Label: status=label_purchased, easypostShipmentId, !refundStatus
 * - Mark Shipped: status=label_purchased, !refundSubmitted
 * - Mark Delivered: status=shipped OR status=in_transit
 * - Cancel Order: status=pending OR label_purchased OR exception (non-combined)
 * - Uncombine: combinedWith != null, status != delivered
 */
export default function MarketplaceShipmentActions({
  shipment,
  onOpenRatesModal,
  onStatusChange,
  onOpenImportModal,
  onOpenCombineModal,
}) {
  const [loading, setLoading] = useState(false);
  const [selectedAction, setSelectedAction] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const dropdownButtonRef = useRef(null);
  const pweThresholdCents = 749;

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

  // Combined shipment state
  const combinedWith = shipment.combinedWith;
  const isCombinedParent = shipment.isCombinedParent;
  const labelActionsDisabled = shipment.labelActionsDisabled;

  const formatCurrency = (cents) => {
    if (!Number.isFinite(cents)) return '—';
    return `$${(cents / 100).toFixed(2)}`;
  };

  // API handlers
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

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
      }

      if (onStatusChange) {
        onStatusChange(shipment.id, newStatus);
      }
    } catch (err) {
      window.alert(err?.message || 'Failed to update status');
    } finally {
      setLoading(false);
      setSelectedAction(null);
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
      setSelectedAction(null);
    }
  };

  const handleRefund = async () => {
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
      setSelectedAction(null);
    }
  };

  const handleUncombine = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/uncombine`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        }
      );
      const data = await response.json();

      if (data.ok) {
        if (onStatusChange) onStatusChange(shipment.id, shipment.status);
      } else {
        window.alert(`Uncombine failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      window.alert(`Uncombine failed: ${err.message || 'Network error'}`);
    } finally {
      setLoading(false);
      setSelectedAction(null);
    }
  };

  // Build available actions list
  const actions = [];

  // Pre-shipment actions (status=pending)
  if (status === 'pending') {
    if (!shipment.isExternal && !shipment.isPwe && !labelActionsDisabled) {
      actions.push({
        key: 'purchase_label',
        label: 'Purchase Label',
        variant: 'primary',
        confirm: false,
        handler: () => onOpenRatesModal(shipment),
      });
    }
    if (shipment.isExternal && onOpenImportModal) {
      actions.push({
        key: 'import_shipping',
        label: 'Import Shipping Export',
        variant: 'warning',
        confirm: false,
        handler: () => onOpenImportModal(),
      });
    }
    if (!labelActionsDisabled) {
      actions.push({
        key: 'combine',
        label: 'Combine with...',
        variant: 'default',
        confirm: false,
        handler: () => onOpenCombineModal?.(shipment),
      });
    }
  }

  // Order cancellation (terminal state for operator workflow)
  if (
    (status === 'pending' || status === 'label_purchased' || status === 'exception') &&
    !combinedWith &&
    !isCombinedParent
  ) {
    actions.push({
      key: 'cancel_order',
      label: 'Cancel Order',
      variant: 'danger',
      confirm: true,
      confirmMessage:
        `Cancel order ${shipment.orderNumber || `#${shipment.id}`}?\n\n` +
        `This marks the order as cancelled and removes it from active fulfillment.`,
      handler: () => updateStatus('cancelled', 'Cancelled by operator from fulfillment dashboard'),
    });
  }

  // PWE toggle (pending or label_purchased)
  if ((status === 'pending' || status === 'label_purchased') && !labelActionsDisabled) {
    if (shipment.isPwe) {
      actions.push({
        key: 'undo_pwe',
        label: 'Undo PWE',
        variant: 'default',
        confirm: true,
        confirmMessage: 'Undo PWE?\n\nThis re-enables tracked label purchase for this shipment.',
        handler: () => updatePwe(false),
      });
    } else {
      const summaryParts = [];
      if (totalCents != null) summaryParts.push(`Order total: ${formatCurrency(totalCents)}`);
      if (itemCount != null) summaryParts.push(`Cards: ${itemCount}`);
      const summary = summaryParts.length > 0 ? `\n\n${summaryParts.join(' • ')}` : '';
      const warning = isPweCandidate
        ? ''
        : '\n\nWARNING: This order does not meet the PWE threshold (1–3 cards and total < $7.49).';

      actions.push({
        key: 'mark_pwe',
        label: 'Mark PWE',
        variant: 'warning',
        confirm: true,
        confirmMessage: `Mark as PWE (Plain White Envelope / stamp)?${warning}\n\nThis disables label purchase until you undo it.${summary}`,
        handler: () => updatePwe(true),
      });
    }
  }

  // Label purchased actions (disabled for combined children)
  if (status === 'label_purchased' && !labelActionsDisabled) {
    if (!shipment.refundStatus || shipment.refundStatus === 'rejected') {
      actions.push({
        key: 'print_label',
        label: shipment.labelViewedAt ? 'Reprint Label' : 'Print Label',
        variant: 'primary',
        isLink: true,
        href: `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/label/optimized?format=pdf`,
      });

      if (shipment.easypostShipmentId) {
        actions.push({
          key: 'refund_label',
          label: 'Refund Label',
          variant: 'warning',
          confirmMessage: `Request label refund for shipment #${shipment.id}?\n\n` +
            `Tracking: ${shipment.trackingNumber || 'N/A'}\n\n` +
            `USPS refunds require:\n` +
            `• Label created within 30 days\n` +
            `• Package NOT scanned by USPS\n\n` +
            `Proceed with refund request?`,
          handler: handleRefund,
        });
      }

      if (!shipment.refundStatus) {
        actions.push({
          key: 'mark_shipped',
          label: 'Mark Shipped',
          variant: 'success',
          handler: () => updateStatus('shipped'),
        });
      }
    }
  }

  // Shipped / In-Transit actions (disabled for combined children)
  if ((status === 'shipped' || status === 'in_transit') && !labelActionsDisabled) {
    actions.push({
      key: 'mark_delivered',
      label: 'Mark Delivered',
      variant: 'success',
      handler: () => updateStatus('delivered'),
    });
  }

  // Combined child: Uncombine action
  if (combinedWith && status !== 'delivered' && status !== 'cancelled') {
    actions.push({
      key: 'uncombine',
      label: 'Uncombine',
      variant: 'default',
      confirm: true,
      confirmMessage: `Uncombine this shipment from ${combinedWith.parentOrderNumber}?\n\nThis will detach it from the parent and require separate fulfillment.`,
      handler: handleUncombine,
    });
  }

  // Execute the selected action (called when confirm button clicked)
  const executeAction = () => {
    if (!selectedAction) return;

    const action = actions.find(a => a.key === selectedAction);
    if (!action) return;

    // For actions with confirmMessage, show dialog first
    if (action.confirmMessage) {
      const confirmed = window.confirm(action.confirmMessage);
      if (!confirmed) {
        setSelectedAction(null);
        return;
      }
    }

    // For links, open in new tab
    if (action.isLink) {
      window.open(action.href, '_blank', 'noopener,noreferrer');
      setSelectedAction(null);
      return;
    }

    action.handler();
  };

  // Handle dropdown selection - ALWAYS stages, never executes immediately
  const handleActionSelect = (actionKey) => {
    const action = actions.find(a => a.key === actionKey);
    if (!action) return;

    setDropdownOpen(false);
    setMenuPosition(null);

    // Stage the action for confirmation (all actions require confirm button)
    setSelectedAction(actionKey);
  };

  // Styles
  const containerStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    alignItems: 'center',
  };

  const dropdownContainerStyle = {
    position: 'relative',
    display: 'inline-block',
  };

  const dropdownButtonStyle = {
    padding: '6px 12px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    backgroundColor: '#fff',
    color: '#374151',
    border: '1px solid #e5e7eb',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  };

  const dropdownMenuStyle = {
    position: 'fixed',
    top: menuPosition?.top ?? 0,
    left: menuPosition?.left ?? 0,
    backgroundColor: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    zIndex: 1200,
    minWidth: `${menuPosition?.minWidth ?? 160}px`,
    maxHeight: 'min(320px, calc(100vh - 16px))',
    overflowY: 'auto',
  };

  const dropdownItemStyle = (variant) => {
    const colors = {
      primary: { color: '#2563EB' },
      success: { color: '#059669' },
      warning: { color: '#D97706' },
      danger: { color: '#DC2626' },
      default: { color: '#374151' },
    };
    return {
      padding: '8px 12px',
      fontSize: '12px',
      fontWeight: 500,
      cursor: 'pointer',
      backgroundColor: '#fff',
      border: 'none',
      width: '100%',
      textAlign: 'left',
      ...colors[variant],
    };
  };

  const confirmButtonStyle = {
    padding: '6px 10px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    backgroundColor: '#059669',
    color: '#fff',
    border: 'none',
  };

  const cancelButtonStyle = {
    padding: '6px 10px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    backgroundColor: '#f3f4f6',
    color: '#374151',
    border: '1px solid #e5e7eb',
  };

  const badgeStyle = (variant) => {
    const styles = {
      pwe: {
        backgroundColor: '#E0E0E0',
        color: '#111827',
        border: '1px solid #D1D5DB',
      },
      combined: {
        backgroundColor: '#DBEAFE',
        color: '#1E40AF',
        border: '1px solid #93C5FD',
      },
      parent: {
        backgroundColor: '#D1FAE5',
        color: '#065F46',
        border: '1px solid #6EE7B7',
      },
      external: {
        backgroundColor: '#FFF3E0',
        color: '#E65100',
        border: '1px solid #FFB74D',
      },
      refund: {
        pending: { backgroundColor: '#FEF3C7', color: '#92400E' },
        refunded: { backgroundColor: '#D1FAE5', color: '#065F46' },
        rejected: { backgroundColor: '#FEE2E2', color: '#991B1B' },
      },
      delivered: {
        backgroundColor: '#D1FAE5',
        color: '#065F46',
      },
      exception: {
        backgroundColor: '#FEE2E2',
        color: '#991B1B',
      },
    };
    return {
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: variant === 'pwe' ? 700 : 500,
      ...(variant === 'refund' ? {} : styles[variant]),
    };
  };

  const getRefundBadgeStyle = (refundStatus) => {
    const styles = {
      submitted: { backgroundColor: '#FEF3C7', color: '#92400E' },
      refunded: { backgroundColor: '#D1FAE5', color: '#065F46' },
      rejected: { backgroundColor: '#FEE2E2', color: '#991B1B' },
    };
    return {
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: 500,
      ...styles[refundStatus],
    };
  };

  useEffect(() => {
    if (!dropdownOpen) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      if (!dropdownButtonRef.current) return;
      const rect = dropdownButtonRef.current.getBoundingClientRect();
      const estimatedHeight = Math.min(320, actions.length * 36 + 12);
      const minWidth = Math.max(rect.width, 160);
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
      const top = openUp
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 4);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - minWidth - 8));
      setMenuPosition({ top, left, minWidth });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [dropdownOpen, actions.length]);

  return (
    <div style={containerStyle}>
      {/* Status badges */}
      {shipment.isPwe && (
        <span
          style={badgeStyle('pwe')}
          title="PWE: Plain White Envelope / stamp-based manual shipping (no tracking)"
        >
          PWE
        </span>
      )}

      {/* Combined child indicator */}
      {combinedWith && (
        <span
          style={badgeStyle('combined')}
          title={`Combined with ${combinedWith.parentOrderNumber} on ${new Date(combinedWith.combinedAt * 1000).toLocaleDateString()} by ${combinedWith.combinedBy}`}
        >
          Combined
        </span>
      )}

      {/* Combined parent indicator */}
      {isCombinedParent && (
        <span
          style={badgeStyle('parent')}
          title="This shipment has other orders combined into it"
        >
          Parent
        </span>
      )}

      {/* External fulfillment indicator */}
      {shipment.isExternal && status === 'pending' && (
        <span
          style={badgeStyle('external')}
          title="Missing address from TCGPlayer Order List export. Import TCGPlayer Shipping Export CSV to enable label purchase."
        >
          Needs Shipping Export
        </span>
      )}

      {/* Refund status badge */}
      {shipment.refundStatus && (
        <span style={getRefundBadgeStyle(shipment.refundStatus)}>
          {shipment.refundStatus === 'submitted' ? 'Refund Pending' :
           shipment.refundStatus === 'refunded' ? 'Refunded' : 'Refund Rejected'}
        </span>
      )}

      {/* Delivered/Exception status indicators */}
      {status === 'delivered' && (
        <span style={badgeStyle('delivered')}>Completed</span>
      )}
      {status === 'exception' && (
        <span style={badgeStyle('exception')}>Exception</span>
      )}

      {/* Actions dropdown */}
      {actions.length > 0 && (
        <div style={dropdownContainerStyle}>
          <button
            ref={dropdownButtonRef}
            style={dropdownButtonStyle}
            onClick={() => {
              setDropdownOpen((prev) => {
                const next = !prev;
                if (!next) setMenuPosition(null);
                return next;
              });
            }}
            disabled={loading}
          >
            {loading ? '...' : 'Actions'}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>

          {dropdownOpen && menuPosition && (
            <>
              {/* Backdrop to close dropdown on outside click */}
              <div
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 1190,
                }}
                onClick={() => {
                  setDropdownOpen(false);
                  setMenuPosition(null);
                }}
              />
              <div style={dropdownMenuStyle}>
                {actions.map((action) => (
                  <button
                    key={action.key}
                    style={dropdownItemStyle(action.variant)}
                    onClick={() => handleActionSelect(action.key)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#fff';
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Staged confirm UI */}
      {selectedAction && (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#6B7280' }}>
            {actions.find(a => a.key === selectedAction)?.label}?
          </span>
          <button
            style={confirmButtonStyle}
            onClick={executeAction}
            disabled={loading}
          >
            {loading ? '...' : '✓'}
          </button>
          <button
            style={cancelButtonStyle}
            onClick={() => setSelectedAction(null)}
            disabled={loading}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
