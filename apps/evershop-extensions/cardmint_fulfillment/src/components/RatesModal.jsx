import React, { useState, useEffect } from 'react';

/**
 * RatesModal Component
 *
 * Displays available shipping rates for a marketplace shipment.
 * Allows full parcel override (preset, dimensions, weight) and rate selection before label purchase.
 * Features auto-pick for recommended rate (USPS Ground Advantage prioritized).
 */

// Parcel preset definitions (must match backend config.ts)
const PARCEL_PRESETS = {
  singlecard: { label: 'Single Card Mailer', length: 6.5, width: 4.5, height: 0.1, weight: 3.0 },
  'multicard-bubble': { label: 'Bubble Mailer', length: 8.0, width: 6.0, height: 1.0, weight: 4.0 },
  'multicard-box': { label: 'Box', length: 10.0, width: 8.0, height: 2.0, weight: 8.0 },
};

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
  const [ratesData, setRatesData] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Parcel controls state
  const [parcelPreset, setParcelPreset] = useState(''); // empty = auto
  const [parcelLength, setParcelLength] = useState('');
  const [parcelWidth, setParcelWidth] = useState('');
  const [parcelHeight, setParcelHeight] = useState('');
  const [customWeightOz, setCustomWeightOz] = useState('');

  // Dirty state: tracks if parcel settings changed since last rate fetch
  const [parcelDirty, setParcelDirty] = useState(false);

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

  const fetchRates = async (isInitialFetch = false) => {
    setLoading(true);
    setError(null);
    setRates([]);
    setSelectedRate(null);
    setParcelDirty(false); // Clear dirty state when fetching

    try {
      const body = {};

      // Only send overrides if not initial fetch AND parcelPreset is set (not Auto)
      // When Auto is selected (empty preset), let backend auto-determine all parcel params
      if (!isInitialFetch && parcelPreset) {
        body.parcelPreset = parcelPreset;
        // Only send dimension/weight overrides when a preset is selected
        if (parcelLength && parseFloat(parcelLength) > 0) {
          body.parcelLength = parseFloat(parcelLength);
        }
        if (parcelWidth && parseFloat(parcelWidth) > 0) {
          body.parcelWidth = parseFloat(parcelWidth);
        }
        if (parcelHeight && parseFloat(parcelHeight) > 0) {
          body.parcelHeight = parseFloat(parcelHeight);
        }
        if (customWeightOz && parseFloat(customWeightOz) > 0) {
          body.customWeightOz = parseFloat(customWeightOz);
        }
      }

      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipmentId}/rates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        }
      );

      const data = await response.json();

      if (!data.ok) {
        setError(data.error || data.message || 'Failed to fetch rates');
        return;
      }

      setRatesData(data);
      setRates(data.rates || []);

      // Pre-populate parcel fields from response (for initial fetch or when not overriding)
      if (isInitialFetch || !parcelPreset) {
        setParcelPreset(data.parcelPreset || '');
      }
      if (isInitialFetch || !parcelLength) {
        setParcelLength(data.parcelLength?.toString() || '');
      }
      if (isInitialFetch || !parcelWidth) {
        setParcelWidth(data.parcelWidth?.toString() || '');
      }
      if (isInitialFetch || !parcelHeight) {
        setParcelHeight(data.parcelHeight?.toString() || '');
      }
      if (isInitialFetch || !customWeightOz) {
        setCustomWeightOz(data.parcelWeightOz?.toString() || '');
      }
    } catch (err) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  // Handle preset change - update dimensions and weight to preset defaults
  const handlePresetChange = (newPreset) => {
    setParcelPreset(newPreset);
    setParcelDirty(true);
    if (newPreset && PARCEL_PRESETS[newPreset]) {
      const preset = PARCEL_PRESETS[newPreset];
      setParcelLength(preset.length.toString());
      setParcelWidth(preset.width.toString());
      setParcelHeight(preset.height.toString());
      setCustomWeightOz(preset.weight.toString());
    } else {
      // Auto selected - clear dimension fields (backend will auto-determine)
      setParcelLength('');
      setParcelWidth('');
      setParcelHeight('');
      setCustomWeightOz('');
    }
  };

  // Handle dimension/weight change - set dirty
  const handleDimensionChange = (setter) => (e) => {
    setter(e.target.value);
    setParcelDirty(true);
  };

  // Auto-pick the recommended rate
  const handleAutoPick = () => {
    const recommended = rates.find((r) => r.recommended);
    if (recommended) {
      setSelectedRate(recommended);
    }
  };

  const handleBuyClick = () => {
    if (!selectedRate) return;
    setShowConfirm(true);
  };

  const handleConfirmCancel = () => {
    setShowConfirm(false);
  };

  const purchaseLabel = async () => {
    if (!selectedRate) return;

    setPurchasing(true);
    setError(null);
    setShowConfirm(false);

    try {
      const response = await fetch(
        `/api/admin/api/fulfillment/marketplace/shipments/${shipmentId}/label`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rateId: selectedRate.id }),
          credentials: 'include',
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
      // Reset state on modal open
      setParcelPreset('');
      setParcelLength('');
      setParcelWidth('');
      setParcelHeight('');
      setCustomWeightOz('');
      setParcelDirty(false);
      setSelectedRate(null);
      setError(null);
      fetchRates(true); // Initial fetch to get defaults
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

        {/* Parcel Controls */}
        <div style={sectionStyle}>
          <div
            style={{
              backgroundColor: '#F9FAFB',
              padding: '16px',
              borderRadius: '6px',
              marginBottom: '12px',
            }}
          >
            {/* Package Type Dropdown */}
            <div style={{ marginBottom: '12px' }}>
              <label style={labelStyle}>Package Type</label>
              <select
                value={parcelPreset}
                onChange={(e) => handlePresetChange(e.target.value)}
                style={{ ...inputStyle, width: '200px' }}
                disabled={loading}
              >
                <option value="">Auto (based on item count)</option>
                {Object.entries(PARCEL_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>{preset.label}</option>
                ))}
              </select>
            </div>

            {/* Dimensions Row */}
            <div style={{ marginBottom: '12px' }}>
              <label style={labelStyle}>Dimensions (inches)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="36"
                  placeholder="L"
                  value={parcelLength}
                  onChange={handleDimensionChange(setParcelLength)}
                  style={{ ...inputStyle, width: '70px' }}
                  disabled={loading || !parcelPreset}
                  title="Length"
                />
                <span style={{ color: '#6B7280' }}>×</span>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="36"
                  placeholder="W"
                  value={parcelWidth}
                  onChange={handleDimensionChange(setParcelWidth)}
                  style={{ ...inputStyle, width: '70px' }}
                  disabled={loading || !parcelPreset}
                  title="Width"
                />
                <span style={{ color: '#6B7280' }}>×</span>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="36"
                  placeholder="H"
                  value={parcelHeight}
                  onChange={handleDimensionChange(setParcelHeight)}
                  style={{ ...inputStyle, width: '70px' }}
                  disabled={loading || !parcelPreset}
                  title="Height"
                />
              </div>
            </div>

            {/* Weight Row */}
            <div style={{ marginBottom: '12px' }}>
              <label style={labelStyle}>Weight (oz)</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="1120"
                placeholder="Weight"
                value={customWeightOz}
                onChange={handleDimensionChange(setCustomWeightOz)}
                style={{ ...inputStyle, width: '100px' }}
                disabled={loading || !parcelPreset}
              />
              {!parcelPreset && (
                <span style={{ marginLeft: '8px', fontSize: '12px', color: '#6B7280' }}>
                  (Auto-determined by item count)
                </span>
              )}
            </div>

            {/* Insurance & Refresh */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '13px' }}>
                <span style={{ color: '#6B7280' }}>Insurance:</span>{' '}
                <strong>
                  {ratesData?.insuredValueCents
                    ? `$${(ratesData.insuredValueCents / 100).toFixed(2)}`
                    : 'None'}
                </strong>
              </div>
              <button
                style={buttonStyle(false, loading)}
                onClick={() => fetchRates(false)}
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Refresh Rates'}
              </button>
            </div>
          </div>
        </div>

        {/* Rates list */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>Select a Rate</label>
            {rates.length > 0 && rates.some((r) => r.recommended) && (
              <button
                style={{
                  padding: '6px 12px',
                  borderRadius: '4px',
                  border: '1px solid #059669',
                  backgroundColor: '#ECFDF5',
                  color: '#059669',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 500,
                }}
                onClick={handleAutoPick}
                disabled={loading}
              >
                Auto-Pick Best Rate
              </button>
            )}
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#6B7280' }}>
              Fetching rates...
            </div>
          ) : rates.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#6B7280' }}>
              No rates available. Try adjusting the parcel settings.
            </div>
          ) : (
            rates.map((rate) => (
              <div
                key={rate.id}
                style={{
                  ...rateRowStyle(selectedRate?.id === rate.id),
                  position: 'relative',
                }}
                onClick={() => setSelectedRate(rate)}
              >
                {rate.recommended && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '-8px',
                      right: '12px',
                      backgroundColor: '#059669',
                      color: '#fff',
                      fontSize: '10px',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '10px',
                      textTransform: 'uppercase',
                    }}
                  >
                    Recommended
                  </div>
                )}
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
                    color: rate.recommended ? '#059669' : '#2563EB',
                  }}
                >
                  {formatCurrency(rate.rate)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Dirty state warning */}
        {parcelDirty && (
          <div
            style={{
              padding: '10px 12px',
              backgroundColor: '#FEF3C7',
              color: '#92400E',
              borderRadius: '4px',
              marginBottom: '12px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontWeight: 500 }}>Parcel settings changed</span>
            <span style={{ color: '#B45309' }}>— click "Refresh Rates" before purchasing</span>
          </div>
        )}

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
            style={buttonStyle(true, !selectedRate || purchasing || parcelDirty)}
            onClick={handleBuyClick}
            disabled={!selectedRate || purchasing || parcelDirty}
            title={parcelDirty ? 'Refresh rates after changing parcel settings' : ''}
          >
            Buy Label
          </button>
        </div>

        {/* Confirmation Dialog */}
        {showConfirm && selectedRate && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: '8px',
            }}
            onClick={handleConfirmCancel}
          >
            <div
              style={{
                backgroundColor: '#fff',
                padding: '24px',
                borderRadius: '8px',
                maxWidth: '400px',
                width: '90%',
                boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', color: '#111827' }}>
                Confirm Label Purchase
              </h3>
              <div
                style={{
                  backgroundColor: '#F9FAFB',
                  padding: '16px',
                  borderRadius: '6px',
                  marginBottom: '16px',
                  fontSize: '14px',
                }}
              >
                <div style={{ marginBottom: '8px' }}>
                  <span style={{ color: '#6B7280' }}>Carrier:</span>{' '}
                  <strong>{selectedRate.carrier}</strong>
                </div>
                <div style={{ marginBottom: '8px' }}>
                  <span style={{ color: '#6B7280' }}>Service:</span>{' '}
                  <strong>{selectedRate.service}</strong>
                </div>
                <div style={{ marginBottom: '8px' }}>
                  <span style={{ color: '#6B7280' }}>Cost:</span>{' '}
                  <strong style={{ color: '#2563EB', fontSize: '16px' }}>
                    {formatCurrency(selectedRate.rate)}
                  </strong>
                </div>
                {ratesData?.insuredValueCents > 0 && (
                  <div>
                    <span style={{ color: '#6B7280' }}>Insurance:</span>{' '}
                    <strong style={{ color: '#059669' }}>
                      ${(ratesData.insuredValueCents / 100).toFixed(2)}
                    </strong>
                  </div>
                )}
              </div>
              <p style={{ fontSize: '13px', color: '#6B7280', marginBottom: '16px' }}>
                This will charge your EasyPost account. This action cannot be undone.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  style={buttonStyle(false, false)}
                  onClick={handleConfirmCancel}
                >
                  Back
                </button>
                <button
                  style={{
                    ...buttonStyle(true, purchasing),
                    backgroundColor: purchasing ? '#9CA3AF' : '#059669',
                  }}
                  onClick={purchaseLabel}
                  disabled={purchasing}
                >
                  {purchasing ? 'Purchasing...' : 'Confirm Purchase'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
