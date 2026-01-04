import React, { useState, useEffect } from 'react';

/**
 * RatesModal Component
 *
 * Displays available shipping rates for a marketplace shipment.
 * Allows weight override and rate selection before label purchase.
 */
export default function RatesModal({
  shipmentId,
  isOpen,
  onClose,
  onLabelPurchased,
  initialItemCount = 1,
  initialOrderValue = 0,
}) {
  const [loading, setLoading] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState(null);
  const [rates, setRates] = useState([]);
  const [selectedRate, setSelectedRate] = useState(null);
  const [customWeightOz, setCustomWeightOz] = useState('');
  const [ratesData, setRatesData] = useState(null);

  // Styles
  const overlayStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: isOpen ? 'flex' : 'none',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  };

  const modalStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    padding: '24px',
    maxWidth: '600px',
    width: '90%',
    maxHeight: '80vh',
    overflow: 'auto',
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
    borderBottom: '1px solid #e5e7eb',
    paddingBottom: '16px',
  };

  const closeButtonStyle = {
    background: 'none',
    border: 'none',
    fontSize: '24px',
    cursor: 'pointer',
    color: '#6B7280',
  };

  const sectionStyle = {
    marginBottom: '20px',
  };

  const labelStyle = {
    display: 'block',
    fontSize: '13px',
    fontWeight: 500,
    color: '#374151',
    marginBottom: '6px',
  };

  const inputStyle = {
    width: '120px',
    padding: '8px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: '4px',
    fontSize: '14px',
  };

  const buttonStyle = (primary = false, disabled = false) => ({
    padding: '10px 20px',
    borderRadius: '4px',
    border: primary ? 'none' : '1px solid #e5e7eb',
    backgroundColor: disabled ? '#f3f4f6' : primary ? '#2563EB' : '#fff',
    color: disabled ? '#9CA3AF' : primary ? '#fff' : '#374151',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '14px',
    fontWeight: 500,
    marginLeft: '8px',
  });

  const rateRowStyle = (isSelected) => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    border: isSelected ? '2px solid #2563EB' : '1px solid #e5e7eb',
    borderRadius: '6px',
    marginBottom: '8px',
    backgroundColor: isSelected ? '#EFF6FF' : '#fff',
    cursor: 'pointer',
  });

  const formatCurrency = (rate) => {
    return `$${parseFloat(rate).toFixed(2)}`;
  };

  const fetchRates = async () => {
    setLoading(true);
    setError(null);
    setRates([]);
    setSelectedRate(null);

    try {
      const body = {};
      if (customWeightOz && parseFloat(customWeightOz) > 0) {
        body.customWeightOz = parseFloat(customWeightOz);
      }

      const response = await fetch(
        `/admin/api/fulfillment/marketplace/shipments/${shipmentId}/rates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json();

      if (!data.ok) {
        setError(data.error || data.message || 'Failed to fetch rates');
        return;
      }

      setRatesData(data);
      setRates(data.rates || []);
    } catch (err) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const purchaseLabel = async () => {
    if (!selectedRate) return;

    setPurchasing(true);
    setError(null);

    try {
      const response = await fetch(
        `/admin/api/fulfillment/marketplace/shipments/${shipmentId}/label`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rateId: selectedRate.id }),
        }
      );

      const data = await response.json();

      if (!data.ok) {
        setError(data.error || data.message || 'Failed to purchase label');
        return;
      }

      // Success - notify parent and close
      if (onLabelPurchased) {
        onLabelPurchased(data);
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Network error');
    } finally {
      setPurchasing(false);
    }
  };

  useEffect(() => {
    if (isOpen && shipmentId) {
      fetchRates();
    }
  }, [isOpen, shipmentId]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: '18px', color: '#111827' }}>
            Shipping Rates
          </h2>
          <button style={closeButtonStyle} onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Error display */}
        {error && (
          <div
            style={{
              padding: '12px',
              backgroundColor: '#FEE2E2',
              color: '#991B1B',
              borderRadius: '4px',
              marginBottom: '16px',
              fontSize: '14px',
            }}
          >
            {error}
          </div>
        )}

        {/* Shipment info */}
        {ratesData && (
          <div style={sectionStyle}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '12px',
                backgroundColor: '#F9FAFB',
                padding: '12px',
                borderRadius: '6px',
                fontSize: '13px',
              }}
            >
              <div>
                <span style={{ color: '#6B7280' }}>Preset:</span>{' '}
                <strong>{ratesData.parcelPreset}</strong>
              </div>
              <div>
                <span style={{ color: '#6B7280' }}>Weight:</span>{' '}
                <strong>{ratesData.parcelWeightOz} oz</strong>
              </div>
              <div>
                <span style={{ color: '#6B7280' }}>Insurance:</span>{' '}
                <strong>
                  {ratesData.insuredValueCents
                    ? `$${(ratesData.insuredValueCents / 100).toFixed(2)}`
                    : 'None'}
                </strong>
              </div>
            </div>
          </div>
        )}

        {/* Weight override */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Weight Override (oz)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder="Auto"
              value={customWeightOz}
              onChange={(e) => setCustomWeightOz(e.target.value)}
              style={inputStyle}
              disabled={loading}
            />
            <button
              style={buttonStyle(false, loading)}
              onClick={fetchRates}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Refresh Rates'}
            </button>
          </div>
        </div>

        {/* Rates list */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Select a Rate</label>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#6B7280' }}>
              Fetching rates...
            </div>
          ) : rates.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#6B7280' }}>
              No rates available. Try adjusting the weight.
            </div>
          ) : (
            rates.map((rate) => (
              <div
                key={rate.id}
                style={rateRowStyle(selectedRate?.id === rate.id)}
                onClick={() => setSelectedRate(rate)}
              >
                <div>
                  <div style={{ fontWeight: 500, color: '#111827' }}>
                    {rate.carrier} - {rate.service}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6B7280' }}>
                    {rate.deliveryDays
                      ? `Est. ${rate.deliveryDays} business days`
                      : 'Delivery time varies'}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: '18px',
                    fontWeight: 600,
                    color: '#2563EB',
                  }}
                >
                  {formatCurrency(rate.rate)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: '16px',
            borderTop: '1px solid #e5e7eb',
          }}
        >
          <button style={buttonStyle(false, false)} onClick={onClose}>
            Cancel
          </button>
          <button
            style={buttonStyle(true, !selectedRate || purchasing)}
            onClick={purchaseLabel}
            disabled={!selectedRate || purchasing}
          >
            {purchasing ? 'Purchasing...' : 'Buy Label'}
          </button>
        </div>
      </div>
    </div>
  );
}
