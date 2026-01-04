import React, { useState, useRef } from 'react';

/**
 * Import Modal Component
 *
 * Handles CSV file upload for TCGPlayer orders and EasyPost tracking.
 * Supports:
 * - File drag-and-drop
 * - Dry-run validation
 * - Import progress and results
 */
export default function ImportModal({ type, onClose }) {
  const [file, setFile] = useState(null);
  const [csvData, setCsvData] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const typeConfig = {
    tcgplayer: {
      title: 'Import TCGPlayer Orders',
      description: 'Upload a CSV file exported from TCGPlayer Seller Portal.',
      endpoint: '/api/admin/api/fulfillment/import/tcgplayer',
      helpText: 'Expected columns: Order Number, Order Date, Recipient, Product Name, Quantity, Product Total, Shipping Cost',
    },
    easypost: {
      title: 'Import EasyPost Tracking',
      description: 'Upload a CSV file exported from EasyPost tracking report.',
      endpoint: '/api/admin/api/fulfillment/import/easypost-tracking',
      helpText: 'Expected columns: Tracker ID, Tracking Number, Carrier, Signed By, Destination ZIP, Status',
    },
  };

  const config = typeConfig[type] || typeConfig.tcgplayer;

  const shouldRefreshAfterImport = (data) => {
    if (!data || dryRun) return false;

    if (type === 'tcgplayer') {
      return (data.imported ?? 0) > 0;
    }

    if (type === 'easypost') {
      return ((data.autoLinked ?? 0) + (data.queued ?? 0) + (data.unmatched ?? 0)) > 0;
    }

    return false;
  };

  // Handlers
  const handleFileChange = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      processFile(selectedFile);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      processFile(droppedFile);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const processFile = (selectedFile) => {
    if (!selectedFile.name.endsWith('.csv')) {
      setError('Please select a CSV file');
      return;
    }

    setFile(selectedFile);
    setError(null);
    setResult(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      setCsvData(e.target.result);
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(selectedFile);
  };

  const handleImport = async () => {
    if (!csvData) {
      setError('Please select a file first');
      return;
    }

    try {
      setImporting(true);
      setError(null);
      setResult(null);

      const response = await fetch(config.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ csvData, dryRun }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setResult(data);

      // If it was a real import (not dry run), refresh after delay
      // Check for any successful imports (TCGPlayer uses 'imported', EasyPost uses 'autoLinked' or 'queued')
      if (shouldRefreshAfterImport(data)) {
        setTimeout(() => {
          onClose(true);
        }, 2000);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    onClose(shouldRefreshAfterImport(result));
  };

  const hasErrors = (result?.errors?.length ?? 0) > 0;
  const didChange = shouldRefreshAfterImport(result);

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
    borderRadius: '12px',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
    width: '500px',
    maxWidth: '90vw',
    maxHeight: '90vh',
    overflow: 'auto',
  };

  const headerStyle = {
    padding: '20px',
    borderBottom: '1px solid #e5e7eb',
  };

  const titleStyle = {
    fontSize: '18px',
    fontWeight: 600,
    color: '#0A203F',
    marginBottom: '4px',
  };

  const descriptionStyle = {
    fontSize: '14px',
    color: '#6B7280',
  };

  const bodyStyle = {
    padding: '20px',
  };

  const dropZoneStyle = {
    border: `2px dashed ${dragOver ? '#4ADC61' : '#e5e7eb'}`,
    borderRadius: '8px',
    padding: '40px 20px',
    textAlign: 'center',
    cursor: 'pointer',
    backgroundColor: dragOver ? 'rgba(74, 220, 97, 0.05)' : '#f9fafb',
    transition: 'all 0.2s ease',
    marginBottom: '16px',
  };

  const fileInfoStyle = {
    padding: '12px',
    backgroundColor: '#E8F5E9',
    borderRadius: '6px',
    marginBottom: '16px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  };

  const checkboxLabelStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
    color: '#374151',
    marginBottom: '16px',
    cursor: 'pointer',
  };

  const helpTextStyle = {
    fontSize: '12px',
    color: '#9CA3AF',
    marginBottom: '16px',
  };

  const errorStyle = {
    padding: '12px',
    backgroundColor: '#FFEBEE',
    borderRadius: '6px',
    color: '#C62828',
    fontSize: '14px',
    marginBottom: '16px',
  };

  const resultStyle = {
    padding: '16px',
    backgroundColor: hasErrors ? '#FFEBEE' : didChange ? '#E8F5E9' : '#FFF8E1',
    borderRadius: '6px',
    marginBottom: '16px',
  };

  const footerStyle = {
    padding: '16px 20px',
    borderTop: '1px solid #e5e7eb',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
  };

  const buttonStyle = {
    padding: '8px 16px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  };

  const cancelButtonStyle = {
    ...buttonStyle,
    backgroundColor: '#f3f4f6',
    color: '#374151',
  };

  const importButtonStyle = {
    ...buttonStyle,
    backgroundColor: dryRun ? '#1565C0' : '#4ADC61',
    color: '#fff',
    opacity: !csvData || importing ? 0.5 : 1,
    cursor: !csvData || importing ? 'not-allowed' : 'pointer',
  };

  return (
    <div style={overlayStyle} onClick={handleClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={titleStyle}>{config.title}</h2>
          <p style={descriptionStyle}>{config.description}</p>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {/* Drop Zone */}
          <div
            style={dropZoneStyle}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <div style={{ marginBottom: '8px' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2" style={{ margin: '0 auto' }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div style={{ color: '#374151', fontWeight: 500 }}>
              Drop CSV file here or click to browse
            </div>
            <div style={{ color: '#9CA3AF', fontSize: '12px', marginTop: '4px' }}>
              Max file size: 10MB
            </div>
          </div>

          {/* File Info */}
          {file && (
            <div style={fileInfoStyle}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2E7D32" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span style={{ color: '#2E7D32', fontWeight: 500 }}>{file.name}</span>
              <span style={{ color: '#6B7280', fontSize: '12px' }}>
                ({(file.size / 1024).toFixed(1)} KB)
              </span>
            </div>
          )}

          {/* Dry Run Checkbox */}
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            <span>
              <strong>Dry run</strong> — validate without importing
            </span>
          </label>

          {/* Help Text */}
          <p style={helpTextStyle}>{config.helpText}</p>

          {/* Error */}
          {error && (
            <div style={errorStyle}>
              {error}
            </div>
          )}

          {/* Result */}
          {result && (
            <div style={resultStyle}>
              <div style={{ fontWeight: 600, marginBottom: '8px', color: '#0A203F' }}>
                {dryRun ? 'Validation Complete' : 'Import Complete'}
              </div>
              <div style={{ fontSize: '14px', color: '#374151' }}>
                {/* TCGPlayer imports show: imported, skipped, errors */}
                {type === 'tcgplayer' && (
                  <>
                    {result.imported > 0 && (
                      <div style={{ color: '#2E7D32' }}>Imported: {result.imported}</div>
                    )}
                    {result.skipped > 0 && (
                      <div style={{ color: '#F57C00' }}>Skipped (duplicates): {result.skipped}</div>
                    )}
                    {result.errors?.length > 0 && (
                      <div style={{ color: '#C62828' }}>Errors: {result.errors.length}</div>
                    )}
                  </>
                )}
                {/* EasyPost tracking imports show: autoLinked, queued, unmatched, errors */}
                {type === 'easypost' && (
                  <>
                    {result.autoLinked > 0 && (
                      <div style={{ color: '#2E7D32' }}>Auto-linked: {result.autoLinked}</div>
                    )}
                    {result.queued > 0 && (
                      <div style={{ color: '#1565C0' }}>Queued for review: {result.queued}</div>
                    )}
                    {result.unmatched > 0 && (
                      <div style={{ color: '#F57C00' }}>Unmatched (needs review): {result.unmatched}</div>
                    )}
                    {result.errors?.length > 0 && (
                      <div style={{ color: '#C62828' }}>Errors: {result.errors.length}</div>
                    )}
                  </>
                )}
              </div>
              {!dryRun && ((result.imported > 0) || (result.autoLinked > 0) || (result.queued > 0)) && (
                <div style={{ marginTop: '8px', fontSize: '13px', color: '#2E7D32' }}>
                  Closing in 2 seconds...
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button style={cancelButtonStyle} onClick={handleClose}>
            Cancel
          </button>
          <button
            style={importButtonStyle}
            onClick={handleImport}
            disabled={!csvData || importing}
          >
            {importing ? 'Processing...' : dryRun ? 'Validate' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
