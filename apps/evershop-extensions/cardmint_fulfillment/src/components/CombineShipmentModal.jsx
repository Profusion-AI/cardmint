import React, { useState, useEffect } from 'react';

/**
 * CombineShipmentModal Component
 *
 * Modal for combining a shipment with an existing parent shipment.
 * - Fetches combine candidates from API
 * - Displays candidate list with order details
 * - Allows parent selection and reason input
 * - Handles address mismatch warnings
 *
 * Props:
 * - shipment: The shipment to be combined (child)
 * - onClose: Callback when modal is closed
 * - onCombined: Callback when combine succeeds (triggers grid refresh)
 */
export default function CombineShipmentModal({ shipment, onClose, onCombined }) {
  const [candidates, setCandidates] = useState([]);
  const [selectedParent, setSelectedParent] = useState(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);

  // Fetch combine candidates on mount
  useEffect(() => {
    const fetchCandidates = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/combine-candidates`,
          { credentials: 'include' }
        );
        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error(data.error || 'Failed to fetch candidates');
        }

        setCandidates(data.candidates || []);
      } catch (err) {
        setError(err.message || 'Failed to load combine candidates');
        setCandidates([]);
      } finally {
        setLoading(false);
      }
    };

    fetchCandidates();
  }, [shipment.id]);

  // Handle combine submission
  const handleCombine = async () => {
    if (!selectedParent) {
      setError('Please select a parent shipment');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Please provide a reason (at least 5 characters)');
      return;
    }

    setSubmitting(true);
    setError(null);
    setWarning(null);

    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipment.id}/combine`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parentShipmentId: selectedParent.shipmentId,
            reason: reason.trim(),
          }),
          credentials: 'include',
        }
      );
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to combine shipments');
      }

      // Show address mismatch warning if present
      if (data.addressMismatchWarning) {
        setWarning(data.addressMismatchWarning);
        // Still consider it a success - close after brief delay
        setTimeout(() => {
          onCombined?.();
          onClose?.();
        }, 2000);
      } else {
        onCombined?.();
        onClose?.();
      }
    } catch (err) {
      setError(err.message || 'Failed to combine shipments');
    } finally {
      setSubmitting(false);
    }
  };

  // Format date for display
  const formatDate = (timestamp) => {
    if (!timestamp) return '—';
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  // Styles
  const overlayStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  };

  const modalStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
    width: '100%',
    maxWidth: '560px',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const headerStyle = {
    padding: '16px 20px',
    borderBottom: '1px solid #e5e7eb',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  };

  const titleStyle = {
    fontSize: '18px',
    fontWeight: 600,
    color: '#111827',
    margin: 0,
  };

  const closeButtonStyle = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '4px',
    color: '#6B7280',
    fontSize: '20px',
    lineHeight: 1,
  };

  const bodyStyle = {
    padding: '20px',
    overflowY: 'auto',
    flex: 1,
  };

  const sectionStyle = {
    marginBottom: '20px',
  };

  const labelStyle = {
    display: 'block',
    fontSize: '14px',
    fontWeight: 500,
    color: '#374151',
    marginBottom: '8px',
  };

  const candidateListStyle = {
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    overflow: 'hidden',
  };

  const candidateItemStyle = (isSelected) => ({
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
    backgroundColor: isSelected ? '#EFF6FF' : '#fff',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  });

  const candidateOrderStyle = {
    fontWeight: 600,
    color: '#111827',
    fontSize: '14px',
  };

  const candidateDetailStyle = {
    fontSize: '12px',
    color: '#6B7280',
    marginTop: '4px',
  };

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    fontSize: '14px',
    boxSizing: 'border-box',
  };

  const textareaStyle = {
    ...inputStyle,
    minHeight: '80px',
    resize: 'vertical',
  };

  const footerStyle = {
    padding: '16px 20px',
    borderTop: '1px solid #e5e7eb',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
    backgroundColor: '#f9fafb',
  };

  const buttonStyle = (variant) => {
    const variants = {
      primary: {
        backgroundColor: '#2563EB',
        color: '#fff',
        border: 'none',
      },
      secondary: {
        backgroundColor: '#fff',
        color: '#374151',
        border: '1px solid #e5e7eb',
      },
    };
    return {
      padding: '10px 20px',
      borderRadius: '6px',
      fontSize: '14px',
      fontWeight: 500,
      cursor: submitting ? 'not-allowed' : 'pointer',
      opacity: submitting ? 0.7 : 1,
      ...variants[variant],
    };
  };

  const alertStyle = (type) => ({
    padding: '12px 16px',
    borderRadius: '6px',
    marginBottom: '16px',
    fontSize: '14px',
    backgroundColor: type === 'error' ? '#FEE2E2' : '#FEF3C7',
    color: type === 'error' ? '#991B1B' : '#92400E',
    border: `1px solid ${type === 'error' ? '#FECACA' : '#FDE68A'}`,
  });

  const emptyStyle = {
    padding: '40px 20px',
    textAlign: 'center',
    color: '#6B7280',
  };

  const loadingStyle = {
    padding: '40px 20px',
    textAlign: 'center',
    color: '#6B7280',
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={titleStyle}>Combine Shipment</h2>
          <button style={closeButtonStyle} onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {/* Error/Warning alerts */}
          {error && <div style={alertStyle('error')}>{error}</div>}
          {warning && <div style={alertStyle('warning')}>{warning}</div>}

          {/* Current shipment info */}
          <div style={sectionStyle}>
            <label style={labelStyle}>Combining shipment:</label>
            <div style={{ padding: '12px', backgroundColor: '#f3f4f6', borderRadius: '6px' }}>
              <div style={{ fontWeight: 600, color: '#111827' }}>
                {shipment.orderNumber || `Shipment #${shipment.id}`}
              </div>
              <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '4px' }}>
                {shipment.customerName || 'Unknown buyer'} • {shipment.itemCount || '?'} item(s)
              </div>
            </div>
          </div>

          {/* Candidate selection */}
          <div style={sectionStyle}>
            <label style={labelStyle}>Select parent shipment to combine with:</label>

            {loading ? (
              <div style={loadingStyle}>Loading candidates...</div>
            ) : candidates.length === 0 ? (
              <div style={emptyStyle}>
                No eligible parent shipments found.
                <div style={{ fontSize: '12px', marginTop: '8px' }}>
                  Candidates must be from the same buyer and have labels already purchased.
                </div>
              </div>
            ) : (
              <div style={candidateListStyle}>
                {candidates.map((candidate) => (
                  <div
                    key={candidate.shipmentId}
                    style={candidateItemStyle(selectedParent?.shipmentId === candidate.shipmentId)}
                    onClick={() => setSelectedParent(candidate)}
                  >
                    <div style={candidateOrderStyle}>
                      {candidate.orderNumber}
                      {selectedParent?.shipmentId === candidate.shipmentId && (
                        <span style={{ marginLeft: '8px', color: '#2563EB' }}>✓</span>
                      )}
                    </div>
                    <div style={candidateDetailStyle}>
                      {candidate.customerName} • {candidate.itemCount} item(s)
                      {candidate.trackingNumber && (
                        <span> • Tracking: {candidate.trackingNumber}</span>
                      )}
                    </div>
                    <div style={candidateDetailStyle}>
                      Shipped: {formatDate(candidate.shippedAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reason input */}
          <div style={sectionStyle}>
            <label style={labelStyle}>
              Reason for combining:
              <span style={{ fontWeight: 400, color: '#6B7280' }}> (required, min 5 chars)</span>
            </label>
            <textarea
              style={textareaStyle}
              placeholder="e.g., Same buyer requested combined shipping, Both orders going to same address..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button
            style={buttonStyle('secondary')}
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            style={buttonStyle('primary')}
            onClick={handleCombine}
            disabled={submitting || !selectedParent || reason.trim().length < 5}
          >
            {submitting ? 'Combining...' : 'Combine Shipments'}
          </button>
        </div>
      </div>
    </div>
  );
}
