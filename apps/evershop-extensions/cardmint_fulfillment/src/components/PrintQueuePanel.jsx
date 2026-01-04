import React, { useEffect, useState, useCallback } from 'react';

/**
 * PrintQueuePanel
 *
 * Phase 5 ops visibility:
 * - Backlog counts (pending/ready/failed, etc.)
 * - Agent heartbeat (last seen)
 * - Failure reasons + manual reprint trigger
 * - Manual "mark reviewed" acknowledgement for printed labels
 * - 2-phase repurchase flow with manual rate selection (CEO decision 2026-01-03)
 */
export default function PrintQueuePanel() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [failedItems, setFailedItems] = useState([]);
  const [needsReviewItems, setNeedsReviewItems] = useState([]);
  const [error, setError] = useState(null);

  // 2-phase repurchase state
  const [rateModalOpen, setRateModalOpen] = useState(false);
  const [pendingRepurchase, setPendingRepurchase] = useState(null); // { queueId, reason, rates, shipmentType, shipmentId }
  const [selectedRateId, setSelectedRateId] = useState(null);
  const [purchasing, setPurchasing] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, failedRes, reviewRes] = await Promise.all([
        fetch('/api/admin/api/fulfillment/print-queue/stats', { credentials: 'include' }),
        fetch('/api/admin/api/fulfillment/print-queue?status=failed&limit=50&offset=0', { credentials: 'include' }),
        fetch('/api/admin/api/fulfillment/print-queue?reviewStatus=needs_review&limit=50&offset=0', { credentials: 'include' }),
      ]);

      const statsData = await statsRes.json();
      const failedData = await failedRes.json();
      const reviewData = await reviewRes.json();

      if (!statsRes.ok || !statsData.ok) throw new Error(statsData.error || 'Failed to load print queue stats');
      if (!failedRes.ok || !failedData.ok) throw new Error(failedData.error || 'Failed to load failed queue items');
      if (!reviewRes.ok || !reviewData.ok) throw new Error(reviewData.error || 'Failed to load review queue items');

      setStats(statsData);
      setFailedItems(failedData.items || []);
      setNeedsReviewItems(reviewData.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load print queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const formatTime = (ts) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  };

  const isAgentStale = () => {
    if (!stats?.latestAgent?.lastSeenAt) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - stats.latestAgent.lastSeenAt > 120; // 2 min stale threshold
  };

  const triggerReprint = async (id) => {
    try {
      const res = await fetch(`/api/admin/api/fulfillment/print-queue/${id}/reprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to reprint');
      fetchAll();
    } catch (err) {
      setError(err.message || 'Failed to reprint');
    }
  };

  const markReviewed = async (id) => {
    try {
      const res = await fetch(`/api/admin/api/fulfillment/print-queue/${id}/mark-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to mark reviewed');
      fetchAll();
    } catch (err) {
      setError(err.message || 'Failed to mark reviewed');
    }
  };

  // Phase 1: Get rates for repurchase
  const repurchaseLabel = async (id) => {
    try {
      const confirmed = window.confirm(
        'Repurchase will buy a NEW label and may create a new charge. This is NOT a reprint. Continue?'
      );
      if (!confirmed) return;

      const reason = window.prompt('Repurchase reason (required, min 5 chars):', '');
      if (!reason || reason.trim().length < 5) {
        setError('Repurchase reason is required (min 5 chars)');
        return;
      }

      // Phase 1: Call without rateId to get available rates
      const res = await fetch(`/api/admin/api/fulfillment/print-queue/${id}/repurchase-label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, repurchaseReason: reason.trim() }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || 'Failed to get rates');
      }

      // Phase 1 response: needsRateSelection - show modal
      if (data.needsRateSelection) {
        setPendingRepurchase({
          queueId: id,
          reason: reason.trim(),
          rates: data.rates || [],
          shipmentType: data.shipmentType,
          shipmentId: data.shipmentId,
        });
        setSelectedRateId(null);
        setRateModalOpen(true);
        return;
      }

      // Direct success (shouldn't happen with current backend, but handle gracefully)
      fetchAll();
    } catch (err) {
      setError(err.message || 'Failed to repurchase label');
    }
  };

  // Phase 2: Purchase with selected rate
  const completeRepurchase = async () => {
    if (!pendingRepurchase || !selectedRateId) return;

    setPurchasing(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/api/fulfillment/print-queue/${pendingRepurchase.queueId}/repurchase-label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          repurchaseReason: pendingRepurchase.reason,
          rateId: selectedRateId,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || 'Failed to purchase label');
      }

      // Handle alreadyPurchased response
      if (data.alreadyPurchased) {
        setError('Label already exists for this shipment (no new charge)');
      }

      // Success - close modal and refresh
      setRateModalOpen(false);
      setPendingRepurchase(null);
      setSelectedRateId(null);
      fetchAll();
    } catch (err) {
      setError(err.message || 'Failed to purchase label');
    } finally {
      setPurchasing(false);
    }
  };

  const closeRateModal = () => {
    setRateModalOpen(false);
    setPendingRepurchase(null);
    setSelectedRateId(null);
  };

  const containerStyle = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    padding: '16px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    marginBottom: '20px',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  };

  const titleStyle = { fontSize: '16px', fontWeight: 600, color: '#0A203F', margin: 0 };

  const buttonStyle = {
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    backgroundColor: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#374151',
  };

  const pill = (bg, color) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    backgroundColor: bg,
    color,
    marginLeft: '8px',
  });

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <h3 style={titleStyle}>Print Queue</h3>
        </div>
        <div style={{ color: '#6B7280', fontSize: '13px' }}>Loading print queue…</div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <h3 style={titleStyle}>
          Print Queue
          {stats?.statusCounts?.failed > 0 && <span style={pill('#FFEBEE', '#C62828')}>FAILED</span>}
          {stats?.needsReview > 0 && <span style={pill('#FFF8E1', '#F57C00')}>NEEDS REVIEW</span>}
        </h3>
        <button style={buttonStyle} onClick={fetchAll}>Refresh</button>
      </div>

      {error && (
        <div style={{ padding: '10px', backgroundColor: '#FFEBEE', color: '#C62828', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      {/* Agent heartbeat */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '12px', fontSize: '13px', color: '#374151' }}>
        <div>
          <strong>Agent:</strong>{' '}
          {stats?.latestAgent ? (
            <>
              {stats.latestAgent.agentId}{' '}
              {isAgentStale() ? <span style={pill('#FFEBEE', '#C62828')}>OFFLINE</span> : <span style={pill('#E8F5E9', '#2E7D32')}>ONLINE</span>}
            </>
          ) : (
            <span style={{ color: '#6B7280' }}>No agent heartbeat</span>
          )}
        </div>
        <div>
          <strong>Last seen:</strong>{' '}
          <span style={{ color: stats?.latestAgent ? '#374151' : '#6B7280' }}>
            {stats?.latestAgent?.lastSeenAt ? formatTime(stats.latestAgent.lastSeenAt) : '—'}
          </span>
        </div>
      </div>

      {/* Counts */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {Object.entries(stats?.statusCounts || {}).map(([k, v]) => (
          <div key={k} style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 12px', minWidth: '120px' }}>
            <div style={{ fontSize: '11px', color: '#6B7280', textTransform: 'uppercase' }}>{k}</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0A203F' }}>{v}</div>
          </div>
        ))}
        <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 12px', minWidth: '120px' }}>
          <div style={{ fontSize: '11px', color: '#6B7280', textTransform: 'uppercase' }}>needs_review</div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#0A203F' }}>{stats?.needsReview ?? 0}</div>
        </div>
      </div>

      {/* Failed items */}
      <div style={{ marginTop: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#0A203F', marginBottom: '8px' }}>
          Failed Jobs ({failedItems.length})
        </div>
        {failedItems.length === 0 ? (
          <div style={{ fontSize: '13px', color: '#6B7280' }}>No failed jobs.</div>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {failedItems.map((item) => (
              <div key={item.id} style={{ border: '1px solid #FECACA', backgroundColor: '#FFEBEE', borderRadius: '8px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ fontSize: '13px', color: '#111827' }}>
                    <strong>{item.orderNumber || `${item.shipmentType}:${item.shipmentId}`}</strong>{' '}
                    <span style={{ color: '#6B7280' }}>• {item.status}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button style={{ ...buttonStyle, borderColor: '#FCA5A5' }} onClick={() => triggerReprint(item.id)}>
                      Reprint / Retry
                    </button>
                    <button style={{ ...buttonStyle, borderColor: '#991B1B', color: '#991B1B' }} onClick={() => repurchaseLabel(item.id)}>
                      Repurchase
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: '#7F1D1D', marginTop: '6px' }}>
                  {item.errorMessage || 'Unknown error'}
                </div>
                <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '6px' }}>
                  Archived: {formatTime(item.archivedAt)} • Printed: {formatTime(item.printedAt)} • Attempts: {item.attempts} • Prints: {item.printCount}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Needs review items */}
      <div style={{ marginTop: '16px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#0A203F', marginBottom: '8px' }}>
          Needs Review ({needsReviewItems.length})
        </div>
        {needsReviewItems.length === 0 ? (
          <div style={{ fontSize: '13px', color: '#6B7280' }}>No items pending review.</div>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {needsReviewItems.slice(0, 20).map((item) => (
              <div key={item.id} style={{ border: '1px solid #FDE68A', backgroundColor: '#FFF8E1', borderRadius: '8px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ fontSize: '13px', color: '#111827' }}>
                    <strong>{item.orderNumber || `${item.shipmentType}:${item.shipmentId}`}</strong>{' '}
                    <span style={{ color: '#6B7280' }}>• {item.status}</span>
                  </div>
                  <button style={{ ...buttonStyle, borderColor: '#F59E0B' }} onClick={() => markReviewed(item.id)}>
                    Mark Reviewed
                  </button>
                </div>
                <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '6px' }}>
                  Archived: {formatTime(item.archivedAt)} • Printed: {formatTime(item.printedAt)} • Prints: {item.printCount}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rate Selection Modal (2-phase repurchase) */}
      {rateModalOpen && pendingRepurchase && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
          onClick={closeRateModal}
        >
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '8px',
              padding: '24px',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid #e5e7eb', paddingBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', color: '#111827' }}>
                Select Shipping Rate
              </h3>
              <button
                style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: '#6B7280' }}
                onClick={closeRateModal}
              >
                &times;
              </button>
            </div>

            {/* Shipment info */}
            <div style={{ backgroundColor: '#F9FAFB', padding: '12px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px' }}>
              <div><strong>Type:</strong> {pendingRepurchase.shipmentType}</div>
              <div><strong>Shipment ID:</strong> {pendingRepurchase.shipmentId}</div>
              <div><strong>Reason:</strong> {pendingRepurchase.reason}</div>
            </div>

            {/* Rate list */}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '8px' }}>
                Available Rates ({pendingRepurchase.rates.length})
              </div>
              {pendingRepurchase.rates.length === 0 ? (
                <div style={{ color: '#6B7280', fontSize: '13px' }}>No rates available.</div>
              ) : (
                pendingRepurchase.rates.map((rate) => (
                  <div
                    key={rate.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px',
                      border: selectedRateId === rate.id ? '2px solid #2563EB' : '1px solid #e5e7eb',
                      borderRadius: '6px',
                      marginBottom: '8px',
                      backgroundColor: selectedRateId === rate.id ? '#EFF6FF' : '#fff',
                      cursor: 'pointer',
                    }}
                    onClick={() => setSelectedRateId(rate.id)}
                  >
                    <div>
                      <div style={{ fontWeight: 500, color: '#111827' }}>
                        {rate.carrier} - {rate.service}
                      </div>
                      <div style={{ fontSize: '12px', color: '#6B7280' }}>
                        {rate.deliveryDays ? `Est. ${rate.deliveryDays} business days` : 'Delivery time varies'}
                      </div>
                    </div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: '#2563EB' }}>
                      ${parseFloat(rate.rate).toFixed(2)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '16px', borderTop: '1px solid #e5e7eb' }}>
              <button
                style={{ ...buttonStyle, backgroundColor: '#f3f4f6' }}
                onClick={closeRateModal}
                disabled={purchasing}
              >
                Cancel
              </button>
              <button
                style={{
                  ...buttonStyle,
                  backgroundColor: !selectedRateId || purchasing ? '#9CA3AF' : '#2563EB',
                  color: '#fff',
                  cursor: !selectedRateId || purchasing ? 'not-allowed' : 'pointer',
                }}
                onClick={completeRepurchase}
                disabled={!selectedRateId || purchasing}
              >
                {purchasing ? 'Purchasing...' : 'Buy Label'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
