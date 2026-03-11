import React, { useState, useEffect, useCallback, useRef } from "react";

// ─── Formatters ────────────────────────────────────────────────────────────────
function formatNumber(num) {
  if (num == null) return "—";
  return new Intl.NumberFormat("en-US").format(num);
}

function formatPercent(num) {
  if (num == null) return "—";
  return (num * 100).toFixed(1) + "%";
}

function formatMs(num) {
  if (num == null) return "—";
  return num.toFixed(0) + "ms";
}

function formatCurrency(cents) {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// ─── Shared primitives ─────────────────────────────────────────────────────────
function StatusDot({ ok }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        backgroundColor: ok ? "#22c55e" : "#ef4444",
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

function Badge({ text, color }) {
  const colors = {
    green: { bg: "#dcfce7", text: "#166534" },
    yellow: { bg: "#fef9c3", text: "#854d0e" },
    red: { bg: "#fef2f2", text: "#991b1b" },
    gray: { bg: "#f3f4f6", text: "#374151" },
    blue: { bg: "#dbeafe", text: "#1e40af" },
  };
  const c = colors[color] || colors.gray;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 500,
        backgroundColor: c.bg,
        color: c.text,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function KpiTile({ label, value, sub }) {
  return (
    <div
      style={{
        background: "#f9fafb",
        borderRadius: 6,
        padding: "14px 18px",
        minWidth: 130,
        flex: "1 1 130px",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function ConfidenceBar({ distribution }) {
  if (!distribution) return null;
  const levels = ["high", "medium", "low", "none"];
  const colors = { high: "#22c55e", medium: "#eab308", low: "#f97316", none: "#ef4444" };
  const total = levels.reduce((sum, l) => sum + (distribution[l] || 0), 0);
  if (total === 0) return <div style={{ color: "#9ca3af" }}>No data</div>;
  return (
    <div>
      <div style={{ display: "flex", height: 20, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
        {levels.map((level) => {
          const pct = ((distribution[level] || 0) / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={level}
              style={{ width: pct + "%", backgroundColor: colors[level] }}
              title={`${level}: ${distribution[level]} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 11, color: "#6b7280" }}>
        {levels.map((level) => (
          <span key={level}>
            <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", backgroundColor: colors[level], marginRight: 3 }} />
            {level}: {distribution[level] || 0}
          </span>
        ))}
      </div>
    </div>
  );
}

function SourceBreakdown({ sources }) {
  if (!sources) return null;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {Object.entries(sources).map(([name, count]) => (
        <div key={name} style={{ background: "#f3f4f6", borderRadius: 6, padding: "6px 12px", fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>{count}</span>{" "}
          <span style={{ color: "#6b7280" }}>{name}</span>
        </div>
      ))}
    </div>
  );
}

function FreshnessBadge({ dateStr }) {
  if (!dateStr) return <Badge text="No data" color="gray" />;
  const ageHours = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  if (ageHours <= 24) return <Badge text="Fresh" color="green" />;
  if (ageHours <= 48) return <Badge text="Aging" color="yellow" />;
  return <Badge text="Stale" color="red" />;
}

// ─── Status Bar (compact health + scorecard, collapsible) ──────────────────────
function StatusBar() {
  const [health, setHealth] = useState(null);
  const [scorecard, setScorecard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        fetch("/api/admin/api/search/health"),
        fetch("/api/admin/api/search/scorecard"),
      ]);
      const [h, s] = await Promise.all([hRes.json(), sRes.json()]);
      setHealth(h);
      setScorecard(s);
    } catch (_) {
      // swallow — dots go red
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const isOk = health?.ok === true;
  const p50 = scorecard?.latency?.p50Ms;
  const resRate = scorecard?.resolution?.resolutionRate;

  return (
    <div>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "9px 14px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: expanded ? "8px 8px 0 0" : 8,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <StatusDot ok={!loading && isOk} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>Search App</span>
        {!loading && p50 != null && (
          <span style={{ fontSize: 13, color: "#6b7280" }}>{formatMs(p50)} p50</span>
        )}
        {!loading && resRate != null && (
          <span style={{ fontSize: 13, color: "#6b7280" }}>{resRate} resolved</span>
        )}
        {loading && <span style={{ fontSize: 12, color: "#9ca3af" }}>Loading…</span>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={(e) => { e.stopPropagation(); fetchData(); }}
            style={{
              padding: "3px 10px",
              background: "#fff",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              fontSize: 13,
              cursor: "pointer",
              color: "#374151",
            }}
            title="Refresh"
          >
            ↻
          </button>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && !loading && (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderTop: "none",
            borderRadius: "0 0 8px 8px",
            padding: 20,
            background: "#fff",
          }}
        >
          {health && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                Service Health
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                {health.stage && <KpiTile label="Stage" value={health.stage} />}
                {health.deviceTier && <KpiTile label="Device Tier" value={health.deviceTier} />}
                <KpiTile
                  label="Vector Search"
                  value={health.vectorAdapterActive ? "Active" : health.vectorSearchEnabled ? "Enabled" : "Disabled"}
                />
              </div>
              {health.db && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {Object.entries(health.db).map(([name, db]) => (
                    <div key={name} style={{ background: "#f9fafb", borderRadius: 6, padding: "10px 14px", flex: "1 1 160px" }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{name}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {db.connected
                          ? <span><StatusDot ok={true} />Connected</span>
                          : <span><StatusDot ok={false} />Disconnected</span>}
                      </div>
                      {(db.productCount ?? db.corpusCount) != null && (
                        <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
                          {formatNumber(db.productCount ?? db.corpusCount)} records
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {scorecard && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                Scorecard
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                <KpiTile label="Total Queries" value={formatNumber(scorecard.queryCount)} />
                <KpiTile label="Resolution Rate" value={scorecard.resolution?.resolutionRate ?? "—"} />
                <KpiTile label="P50 Latency" value={formatMs(scorecard.latency?.p50Ms)} />
                <KpiTile label="P95 Latency" value={formatMs(scorecard.latency?.p95Ms)} />
                <KpiTile label="Correction Rate" value={scorecard.corrections?.correctionRate ?? "—"} />
              </div>
              {scorecard.confidence && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>Confidence Distribution</div>
                  <ConfidenceBar distribution={scorecard.confidence} />
                </div>
              )}
              {scorecard.source && (
                <div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>Source Breakdown</div>
                  <SourceBreakdown sources={scorecard.source} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Enrich Panel ──────────────────────────────────────────────────────────────
function EnrichPanel({ data, loading, error }) {
  if (loading) return (
    <div style={{ padding: "12px 14px", background: "#f3f4f6", borderRadius: 6, fontSize: 13, color: "#6b7280" }}>
      Fetching TCGDex market pricing…
    </div>
  );
  if (error) return (
    <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#991b1b", fontSize: 13 }}>
      Enrichment error: {error}
    </div>
  );
  if (!data) return null;
  if (!data.success) return (
    <div style={{ padding: "10px 14px", background: "#fef9c3", border: "1px solid #fde68a", borderRadius: 6, color: "#854d0e", fontSize: 13 }}>
      TCGDex enrichment failed: {data.error || "Unknown error"}
    </div>
  );
  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <Badge text="TCGDex" color="blue" />
        <Badge text={data.fromCache ? "Cached" : "Live"} color={data.fromCache ? "gray" : "green"} />
      </div>
      {data.card && (
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 8 }}>
          <strong>{data.card.name}</strong>
          {data.card.setName && <span style={{ color: "#6b7280" }}> — {data.card.setName}</span>}
          {data.card.cardNumber && <span style={{ color: "#6b7280" }}> #{data.card.cardNumber}</span>}
        </div>
      )}
      {data.prices?.variants && Object.keys(data.prices.variants).length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Variant</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Condition</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Price</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Listings</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.prices.variants).map(([variant, conditions]) =>
                Object.entries(conditions).map(([cond, info], ci) => (
                  <tr key={`${variant}-${cond}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    {ci === 0 && (
                      <td style={{ padding: "5px 8px", fontWeight: 500 }} rowSpan={Object.keys(conditions).length}>
                        {variant}
                      </td>
                    )}
                    <td style={{ padding: "5px 8px" }}>{cond}</td>
                    <td style={{ padding: "5px 8px", fontWeight: 600 }}>
                      {info.price != null ? "$" + Number(info.price).toFixed(2) : "—"}
                    </td>
                    <td style={{ padding: "5px 8px", color: "#6b7280" }}>{info.listings ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : data.prices?.market != null ? (
        <div style={{ fontSize: 13 }}>
          <strong>Market Price:</strong> ${Number(data.prices.market).toFixed(2)}
          {data.prices.label && <span style={{ color: "#6b7280" }}> ({data.prices.label})</span>}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#9ca3af" }}>No TCGDex market pricing available</div>
      )}
    </div>
  );
}

// ─── Intel Panel ───────────────────────────────────────────────────────────────
function IntelPanel({ data, loading, error }) {
  if (loading) return (
    <div style={{ padding: "12px 14px", background: "#f3f4f6", borderRadius: 6, fontSize: 13, color: "#6b7280" }}>
      Loading market intel…
    </div>
  );
  if (error) return (
    <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#991b1b", fontSize: 13 }}>
      Intel error: {error}
    </div>
  );
  if (!data) return null;
  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 14 }}>
      <h4 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 600, color: "#374151" }}>
        Listed-vs-Market Intel
        {data.card?.name && <span style={{ fontWeight: 400, color: "#6b7280" }}> — {data.card.name}</span>}
      </h4>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>Your Listings (TCG Snapshot)</span>
            {data.snapshot && <FreshnessBadge dateStr={data.snapshot.uploadedAt} />}
          </div>
          {data.listings && data.listings.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "5px 8px", fontWeight: 600 }}>Condition</th>
                  <th style={{ padding: "5px 8px", fontWeight: 600 }}>Qty</th>
                  <th style={{ padding: "5px 8px", fontWeight: 600 }}>Your Price</th>
                </tr>
              </thead>
              <tbody>
                {data.listings.map((l, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "5px 8px" }}>{l.condition}</td>
                    <td style={{ padding: "5px 8px" }}>{l.quantity}</td>
                    <td style={{ padding: "5px 8px", fontWeight: 600 }}>{formatCurrency(l.yourPriceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: "#9ca3af" }}>
              {data.snapshot ? "No active listings" : "No snapshot data available"}
            </div>
          )}
        </div>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>Market Prices (Snapshot)</span>
            {data.snapshot && <FreshnessBadge dateStr={data.snapshot.uploadedAt} />}
          </div>
          {data.market?.prices && Object.keys(data.market.prices).length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "5px 8px", fontWeight: 600 }}>Condition</th>
                  <th style={{ padding: "5px 8px", fontWeight: 600 }}>Market Price</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.market.prices).map(([cond, price]) => (
                  <tr key={cond} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "5px 8px" }}>{cond}</td>
                    <td style={{ padding: "5px 8px", fontWeight: 600 }}>{formatCurrency(price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: "#9ca3af" }}>No snapshot market data</div>
          )}
        </div>
      </div>
      {data.actions && data.actions.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Recommended Actions</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Condition</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Your Price</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Market Price</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Deviation</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.actions.map((a, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "5px 8px" }}>{a.condition}</td>
                  <td style={{ padding: "5px 8px", fontWeight: 600 }}>{formatCurrency(a.yourPrice)}</td>
                  <td style={{ padding: "5px 8px", fontWeight: 600 }}>{formatCurrency(a.marketPrice)}</td>
                  <td style={{ padding: "5px 8px" }}>
                    {a.deviationPct != null ? `${a.deviationPct > 0 ? "+" : ""}${a.deviationPct}%` : "—"}
                  </td>
                  <td style={{ padding: "5px 8px" }}>
                    <Badge text={a.action} color={a.action === "ok" ? "green" : a.action === "review" ? "yellow" : "red"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.card && (
        <div style={{ marginTop: 10, textAlign: "right" }}>
          <button
            onClick={() => {
              const params = new URLSearchParams();
              if (data.card?.name) params.set("cardName", data.card.name);
              if (data.card?.setName) params.set("setName", data.card.setName);
              if (data.card?.cardNumber) params.set("collectorNo", data.card.cardNumber);
              if (data.card?.tcgPlayerId) params.set("tcgPlayerId", data.card.tcgPlayerId);
              window.open(`/api/admin/api/search/card-intel/export?${params.toString()}`);
            }}
            style={{
              padding: "5px 12px",
              background: "#fff",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              color: "#374151",
              cursor: "pointer",
            }}
          >
            Export CSV
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Snapshot Panel ────────────────────────────────────────────────────────────
function SnapshotPanel({ data, loading, error }) {
  if (loading) return (
    <div style={{ padding: "12px 14px", background: "#f3f4f6", borderRadius: 6, fontSize: 13, color: "#6b7280" }}>
      Looking up snapshot pricing…
    </div>
  );
  if (error) return (
    <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#991b1b", fontSize: 13 }}>
      Snapshot error: {error}
    </div>
  );
  if (!data) return null;
  const isAmbiguous = data.status === "needs_review" && Array.isArray(data.candidates) && data.candidates.length > 1;
  return (
    <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <Badge text="Snapshot" color="green" />
        <Badge
          text={data.status}
          color={data.status === "matched" ? "green" : data.status === "needs_review" ? "yellow" : "red"}
        />
        {data.candidateCount > 1 && (
          <span style={{ fontSize: 11, color: "#6b7280" }}>{data.candidateCount} candidates</span>
        )}
      </div>
      {isAmbiguous ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#92400e", marginBottom: 6 }}>
            {data.candidates.length} candidate products — verify correct card:
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#fef3c7" }}>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Product</th>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Set</th>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>#</th>
                <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600 }}>NM Market</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #fde68a" }}>
                  <td style={{ padding: "4px 8px" }}>{c.productName}</td>
                  <td style={{ padding: "4px 8px" }}>{c.setName}</td>
                  <td style={{ padding: "4px 8px" }}>{c.cardNumber || "—"}</td>
                  <td style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600 }}>{formatCurrency(c.nmMarketPriceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data.matchedProduct ? (
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 8 }}>
          <strong>{data.matchedProduct.productName}</strong>
          {data.matchedProduct.setName && <span style={{ color: "#6b7280" }}> — {data.matchedProduct.setName}</span>}
          {data.matchedProduct.cardNumber && <span style={{ color: "#6b7280" }}> #{data.matchedProduct.cardNumber}</span>}
        </div>
      ) : null}
      {!isAmbiguous && data.prices && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <KpiTile label="Market Price" value={formatCurrency(data.prices.marketPriceCents)} />
          <KpiTile label="Direct Low" value={formatCurrency(data.prices.directLowCents)} />
          <KpiTile label="Low + Ship" value={formatCurrency(data.prices.lowPriceShipCents)} />
          <KpiTile label="Low Price" value={formatCurrency(data.prices.lowPriceCents)} />
          <KpiTile label="Marketplace" value={formatCurrency(data.prices.marketplacePriceCents)} />
        </div>
      )}
      {data.conditions && data.conditions.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #bbf7d0", textAlign: "left" }}>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Condition</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Qty</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Market</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Direct Low</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Low+Ship</th>
                <th style={{ padding: "5px 8px", fontWeight: 600 }}>Marketplace</th>
              </tr>
            </thead>
            <tbody>
              {data.conditions.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "5px 8px" }}>{c.conditionBucket}</td>
                  <td style={{ padding: "5px 8px" }}>{c.quantity}</td>
                  <td style={{ padding: "5px 8px", fontWeight: 600 }}>{formatCurrency(c.marketPriceCents)}</td>
                  <td style={{ padding: "5px 8px" }}>{formatCurrency(c.directLowCents)}</td>
                  <td style={{ padding: "5px 8px" }}>{formatCurrency(c.lowPriceShipCents)}</td>
                  <td style={{ padding: "5px 8px" }}>{formatCurrency(c.marketplacePriceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.reason && <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>{data.reason}</div>}
    </div>
  );
}

// ─── Search Area ───────────────────────────────────────────────────────────────
function SearchArea() {
  const [query, setQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searchResult, setSearchResult] = useState(null);
  const [workingCard, setWorkingCard] = useState(null);
  const [activePanel, setActivePanel] = useState(null);
  const [enrichData, setEnrichData] = useState(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichError, setEnrichError] = useState(null);
  const [intelData, setIntelData] = useState(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelError, setIntelError] = useState(null);
  const [snapshotData, setSnapshotData] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const hasTcgDexData = useCallback(
    (item) => Boolean((item?.set || item?.setName) && (item?.collectorNumber || item?.number)),
    []
  );

  const doEnrich = useCallback(async (item) => {
    if (!hasTcgDexData(item)) {
      setEnrichError("TCGDex enrichment requires both set and collector number.");
      setEnrichData(null);
      return;
    }
    setEnrichLoading(true);
    setEnrichError(null);
    setEnrichData(null);
    try {
      const res = await fetch("/api/admin/api/search/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardName: item.name || item.cardName,
          setName: item.set || item.setName,
          collectorNo: item.collectorNumber || item.number,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEnrichError(data.error || data.message || "Enrichment failed");
      } else {
        setEnrichData(data);
      }
    } catch (e) {
      setEnrichError(e.message);
    } finally {
      setEnrichLoading(false);
    }
  }, [hasTcgDexData]);

  const doIntel = useCallback(async (item) => {
    setIntelLoading(true);
    setIntelError(null);
    setIntelData(null);
    try {
      const res = await fetch("/api/admin/api/search/card-intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tcgPlayerId: item.tcgPlayerId,
          cardName: item.name || item.cardName,
          setName: item.set || item.setName,
          collectorNo: item.collectorNumber || item.number,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setIntelError(data.error || data.message || "Intel failed");
      } else {
        setIntelData(data);
      }
    } catch (e) {
      setIntelError(e.message);
    } finally {
      setIntelLoading(false);
    }
  }, []);

  const doSnapshotLookup = useCallback(async (item) => {
    setSnapshotLoading(true);
    setSnapshotError(null);
    setSnapshotData(null);
    try {
      const res = await fetch("/api/admin/api/search/snapshot-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tcgPlayerId: item.tcgPlayerId,
          cardName: item.name || item.cardName,
          setName: item.set || item.setName,
          collectorNo: item.collectorNumber || item.number,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSnapshotError(data.error || data.message || "Snapshot lookup failed");
      } else {
        setSnapshotData(data);
      }
    } catch (e) {
      setSnapshotError(e.message);
    } finally {
      setSnapshotLoading(false);
    }
  }, []);

  const clearPanelData = useCallback(() => {
    setEnrichData(null);
    setEnrichError(null);
    setIntelData(null);
    setIntelError(null);
    setSnapshotData(null);
    setSnapshotError(null);
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResult(null);
    setWorkingCard(null);
    setActivePanel(null);
    clearPanelData();
    try {
      const res = await fetch("/api/admin/api/search/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || data.message || "Search failed");
      } else {
        setSearchResult(data);
        if (data.status === "resolved" && data.results?.length > 0) {
          setWorkingCard(data.results[0]);
        }
      }
    } catch (e) {
      setSearchError(e.message);
    } finally {
      setSearchLoading(false);
    }
  }, [query, clearPanelData]);

  const handleAccept = useCallback((candidate) => {
    setWorkingCard(candidate);
    setActivePanel("enrich");
    setEnrichData(null);
    setEnrichError(null);
    doEnrich(candidate);
  }, [doEnrich]);

  const handleTogglePanel = useCallback((panelId) => {
    if (activePanel === panelId) {
      setActivePanel(null);
      return;
    }
    setActivePanel(panelId);
    if (panelId === "enrich") { setEnrichData(null); setEnrichError(null); doEnrich(workingCard); }
    else if (panelId === "intel") { setIntelData(null); setIntelError(null); doIntel(workingCard); }
    else if (panelId === "snapshot") { setSnapshotData(null); setSnapshotError(null); doSnapshotLookup(workingCard); }
  }, [activePanel, workingCard, doEnrich, doIntel, doSnapshotLookup]);

  const confColor = (c) => c === "high" ? "green" : c === "medium" ? "yellow" : c === "low" ? "red" : "gray";
  const candidates = searchResult?.results || [];
  const isResolved = searchResult?.status === "resolved";
  const needsDisambig = searchResult?.status === "needs_disambiguation";
  const hasNoCandidates = needsDisambig && candidates.length === 0;
  const hasDisambigCandidates = needsDisambig && candidates.length > 0;
  const disambigReason = searchResult?.disambiguationReason
    || searchResult?.disambiguation?.reason
    || (typeof searchResult?.disambiguation === "string" ? searchResult.disambiguation : null);

  const actionBtnStyle = (panelId, baseColor, activeColor) => ({
    padding: "5px 14px",
    background: activePanel === panelId ? activeColor : baseColor,
    color: "#fff",
    border: "none",
    borderRadius: 5,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  return (
    <div>
      {/* Search hero */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="e.g. pikachu base set 58/102"
            style={{
              flex: 1,
              padding: "12px 16px",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              fontSize: 16,
              outline: "none",
            }}
          />
          <button
            onClick={handleSearch}
            disabled={searchLoading || !query.trim()}
            style={{
              padding: "12px 24px",
              background: searchLoading ? "#9ca3af" : "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 600,
              cursor: searchLoading ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {searchLoading ? "Searching…" : "Search"}
          </button>
        </div>

        {/* HTTP error banner */}
        {searchError && (
          <div style={{
            marginTop: 10,
            padding: "10px 14px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#991b1b",
            fontSize: 13,
          }}>
            {searchError}
          </div>
        )}

        {/* No candidates — not an error, just empty */}
        {hasNoCandidates && (
          <div style={{
            marginTop: 10,
            padding: "10px 14px",
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            color: "#6b7280",
            fontSize: 13,
          }}>
            {disambigReason || "No matching cards found"}
          </div>
        )}
      </div>

      {/* Working card result row */}
      {workingCard && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <Badge
              text={isResolved ? "resolved" : "needs_disambiguation"}
              color={isResolved ? "green" : "yellow"}
            />
            {searchResult?.retrievalPath && (
              <span style={{ fontSize: 12, color: "#6b7280" }}>
                path: <strong>{searchResult.retrievalPath}</strong>
              </span>
            )}
          </div>

          <div style={{
            background: "#fff",
            border: `2px solid ${isResolved ? "#bbf7d0" : "#fde68a"}`,
            borderRadius: 8,
            padding: 16,
          }}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              {/* Card image */}
              <div style={{ flexShrink: 0 }}>
                {workingCard.imageUrl ? (
                  <img
                    src={workingCard.imageUrl}
                    alt={workingCard.name || "card"}
                    style={{ width: 52, height: 72, objectFit: "cover", borderRadius: 4 }}
                  />
                ) : (
                  <div style={{
                    width: 52, height: 72, background: "#f3f4f6", borderRadius: 4,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, color: "#9ca3af",
                  }}>
                    N/A
                  </div>
                )}
              </div>

              {/* Card details + actions */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 16, color: "#111827", marginBottom: 3 }}>
                  {workingCard.name || workingCard.cardName || "—"}
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
                  {workingCard.set || workingCard.setName || "—"}
                  {workingCard.collectorNumber && <span> · #{workingCard.collectorNumber}</span>}
                  {workingCard.condition && <span> · {workingCard.condition}</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {(workingCard.price != null || workingCard.priceCents != null) && (
                    <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>
                      {workingCard.priceCents != null
                        ? formatCurrency(workingCard.priceCents)
                        : "$" + Number(workingCard.price).toFixed(2)}
                    </span>
                  )}
                  <Badge text={workingCard.confidence || "—"} color={confColor(workingCard.confidence)} />
                  <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                    <button
                      onClick={() => handleTogglePanel("enrich")}
                      disabled={!hasTcgDexData(workingCard)}
                      title={!hasTcgDexData(workingCard) ? "Set and collector number required" : "Fetch TCGDex market pricing"}
                      style={{
                        ...actionBtnStyle("enrich", "#7c3aed", "#5b21b6"),
                        opacity: !hasTcgDexData(workingCard) ? 0.5 : 1,
                        cursor: !hasTcgDexData(workingCard) ? "not-allowed" : "pointer",
                      }}
                    >
                      {activePanel === "enrich" ? "▲ Enrich" : "Enrich"}
                    </button>
                    <button
                      onClick={() => handleTogglePanel("intel")}
                      style={actionBtnStyle("intel", "#0891b2", "#0e7490")}
                    >
                      {activePanel === "intel" ? "▲ Intel" : "Intel"}
                    </button>
                    <button
                      onClick={() => handleTogglePanel("snapshot")}
                      style={actionBtnStyle("snapshot", "#059669", "#047857")}
                    >
                      {activePanel === "snapshot" ? "▲ Snap" : "Snap"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Inline panels */}
            {activePanel === "enrich" && (
              <div style={{ marginTop: 14 }}>
                <EnrichPanel data={enrichData} loading={enrichLoading} error={enrichError} />
              </div>
            )}
            {activePanel === "intel" && (
              <div style={{ marginTop: 14 }}>
                <IntelPanel data={intelData} loading={intelLoading} error={intelError} />
              </div>
            )}
            {activePanel === "snapshot" && (
              <div style={{ marginTop: 14 }}>
                <SnapshotPanel data={snapshotData} loading={snapshotLoading} error={snapshotError} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Disambiguation candidate list */}
      {hasDisambigCandidates && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Badge text="needs_disambiguation" color="yellow" />
            <span style={{ fontSize: 13, color: "#6b7280" }}>
              {candidates.length} candidate{candidates.length !== 1 ? "s" : ""}
              {disambigReason && <span> — {disambigReason}</span>}
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>Card Name</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>Set</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>#</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>Condition</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>Price</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>Confidence</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c, i) => {
                  const isActive = workingCard === c;
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: "1px solid #f3f4f6",
                        background: isActive ? "#fefce8" : undefined,
                      }}
                    >
                      <td style={{ padding: "8px 10px", fontWeight: 500 }}>{c.name || c.cardName || "—"}</td>
                      <td style={{ padding: "8px 10px", color: "#6b7280" }}>{c.set || c.setName || "—"}</td>
                      <td style={{ padding: "8px 10px", color: "#6b7280" }}>{c.collectorNumber || "—"}</td>
                      <td style={{ padding: "8px 10px" }}>{c.condition || "—"}</td>
                      <td style={{ padding: "8px 10px", fontWeight: 600 }}>
                        {c.priceCents != null
                          ? formatCurrency(c.priceCents)
                          : c.price != null
                          ? "$" + Number(c.price).toFixed(2)
                          : "—"}
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <Badge text={c.confidence || "—"} color={confColor(c.confidence)} />
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <button
                          onClick={() => handleAccept(c)}
                          style={{
                            padding: "4px 12px",
                            background: isActive ? "#6b7280" : "#2563eb",
                            color: "#fff",
                            border: "none",
                            borderRadius: 4,
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: isActive ? "default" : "pointer",
                          }}
                          disabled={isActive}
                        >
                          {isActive ? "Active" : "Accept"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Bulk Valuation Section (logic unchanged) ──────────────────────────────────
function BulkValuationSection() {
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setRows(null);
    setSummary(null);
    setFileName(file.name);

    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        setError("CSV has no data rows");
        setLoading(false);
        return;
      }
      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
      const nameIdx = headers.findIndex((h) => /^(product\s*name|card\s*name|name)$/i.test(h));
      const setIdx = headers.findIndex((h) => /^(set\s*name|set)$/i.test(h));
      const numIdx = headers.findIndex((h) => /^(number|card\s*number|collector\s*number|#)$/i.test(h));
      const condIdx = headers.findIndex((h) => /^(condition)$/i.test(h));
      const qtyIdx = headers.findIndex((h) => /^(total\s*quantity|quantity|qty)$/i.test(h));
      if (nameIdx === -1) {
        setError("CSV must have a 'Product Name' or 'Card Name' column");
        setLoading(false);
        return;
      }
      const csvRows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        csvRows.push({
          cardName: cols[nameIdx] || "",
          setName: setIdx >= 0 ? cols[setIdx] || "" : "",
          cardNumber: numIdx >= 0 ? cols[numIdx] || "" : "",
          condition: condIdx >= 0 ? cols[condIdx] || "" : "",
          qty: qtyIdx >= 0 ? parseInt(cols[qtyIdx]) || 1 : 1,
        });
      }
      const res = await fetch("/api/admin/api/search/bulk-valuation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: csvRows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || "Bulk valuation failed");
      } else {
        setSummary(data.summary);
        setRows(data.rows);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  }, []);

  const handleExport = useCallback(() => {
    if (!rows) return;
    const csvLines = ["Input Name,Input Set,Card Number,Status,Matched Product,Matched Set,Market Price,Direct Low,Low+Ship,Marketplace,Reason"];
    for (const r of rows) {
      const mp = r.matchedProduct || {};
      const pr = r.prices || {};
      csvLines.push([
        esc(r.inputName), esc(r.inputSet), esc(r.inputNumber || ""),
        r.status,
        esc(mp.productName || ""), esc(mp.setName || ""),
        centsToDollars(pr.marketPriceCents), centsToDollars(pr.directLowCents),
        centsToDollars(pr.lowPriceShipCents), centsToDollars(pr.marketplacePriceCents),
        esc(r.reason || ""),
      ].join(","));
    }
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk-valuation-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  const statusColor = (s) => s === "matched" ? "green" : s === "needs_review" ? "yellow" : "red";

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "20px 24px" }}>
      <h3 style={{ margin: "0 0 16px 0", fontSize: 14, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Bulk Valuation
      </h3>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <label
          style={{
            padding: "8px 16px",
            background: loading ? "#9ca3af" : "#2563eb",
            color: "#fff",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Processing…" : "Upload CSV for Valuation"}
          <input type="file" accept=".csv" onChange={handleFile} disabled={loading} style={{ display: "none" }} />
        </label>
        {fileName && <span style={{ fontSize: 12, color: "#6b7280" }}>{fileName}</span>}
        {rows && (
          <button
            onClick={handleExport}
            style={{
              padding: "8px 16px",
              background: "#fff",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              color: "#374151",
              cursor: "pointer",
            }}
          >
            Export Results CSV
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#991b1b", fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {summary && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <KpiTile label="Total Rows" value={formatNumber(summary.totalRows)} />
          <KpiTile label="Matched" value={formatNumber(summary.matched)} />
          <KpiTile label="Needs Review" value={formatNumber(summary.needsReview)} />
          <KpiTile label="Not Priceable" value={formatNumber(summary.notPriceable)} />
          <KpiTile label="Total Value" value={formatCurrency(summary.totalValueCents)} />
        </div>
      )}

      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left", position: "sticky", top: 0, background: "#fff" }}>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>Input Name</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>Input Set</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>Matched Product</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>Market Price</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.inputName}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#6b7280" }}>{r.inputSet}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <Badge text={r.status} color={statusColor(r.status)} />
                  </td>
                  <td style={{ padding: "6px 8px" }}>{r.matchedProduct?.productName || "—"}</td>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>
                    {r.prices?.marketPriceCents != null ? formatCurrency(r.prices.marketPriceCents) : "—"}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#6b7280", fontSize: 11 }}>{r.reason || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── CSV helpers ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { cols.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
  }
  cols.push(cur.trim());
  return cols;
}

function esc(v) {
  if (!v) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function centsToDollars(c) {
  if (c == null) return "";
  return (c / 100).toFixed(2);
}

// ─── Root dashboard ────────────────────────────────────────────────────────────
export default function SearchDashboard() {
  const [bulkOpen, setBulkOpen] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 40 }}>
      <StatusBar />
      <SearchArea />

      {/* Utility strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 8, borderTop: "1px solid #e5e7eb" }}>
        <button
          onClick={() => setBulkOpen((v) => !v)}
          style={{
            padding: "8px 16px",
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "#374151",
            cursor: "pointer",
          }}
        >
          Bulk Valuation {bulkOpen ? "▲" : "▼"}
        </button>
        <a
          href="/admin/analytics/tcgplayer"
          style={{
            padding: "8px 16px",
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "#2563eb",
            textDecoration: "none",
          }}
        >
          → TCG Dashboard
        </a>
      </div>

      {bulkOpen && <BulkValuationSection />}
    </div>
  );
}

export const layout = {
  areaId: "content",
  sortOrder: 10,
};
