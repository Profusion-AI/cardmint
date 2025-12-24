import React from "react";

/**
 * Alert configuration - icons and labels for each alert type
 */
const ALERT_CONFIG = {
    STALE_PRICE: { icon: "\uD83D\uDD34", label: "Stale Price", tooltip: "Pricing data marked as stale" },
    VIS_MISMATCH: { icon: "\uD83D\uDFE1", label: "Vis Mismatch", tooltip: "Sold item still visible on storefront" },
    NEG_MARGIN: { icon: "\uD83D\uDFE0", label: "No Margin", tooltip: "Live price is below market price" },
    SYNC_ERROR: { icon: "\uD83D\uDD34", label: "Sync Error", tooltip: "Last sync to EverShop failed" },
};

/**
 * Alerts Row - Shows warning icons for items needing attention
 * Alerts are UI-derived from existing row data (no additional GraphQL field needed)
 */
export default function AlertsRow({ areaProps }) {
    const row = areaProps?.row;
    const alerts = [];

    // Determine inventory status for mismatch check
    const baseStatus = row?.cmInventoryStatus ?? null;
    const qty = row?.inventory?.qty;
    let itemStatus = baseStatus;

    if (itemStatus === "OUT_OF_STOCK") {
        itemStatus = "SOLD";
    }
    if (!itemStatus && typeof qty === "number") {
        itemStatus = qty > 0 ? "IN_STOCK" : "SOLD";
    }
    itemStatus = itemStatus ?? "UNKNOWN";

    // Get sync state and pricing info
    const syncState = row?.cmEvershopSyncState ?? "not_synced";
    const livePrice = row?.price?.regular?.value ?? 0;
    const marketPrice = row?.cmMarketPrice ?? 0;
    const pricingStatus = row?.cmPricingStatus ?? null;

    // Check for STALE_PRICE: pricing marked as stale
    if (pricingStatus === "stale") {
        alerts.push("STALE_PRICE");
    }

    // Check for VIS_MISMATCH: sold item still visible
    if (itemStatus === "SOLD" && syncState === "evershop_live") {
        alerts.push("VIS_MISMATCH");
    }

    // Check for NEG_MARGIN: live price below market price
    if (marketPrice > 0 && livePrice > 0 && livePrice < marketPrice) {
        alerts.push("NEG_MARGIN");
    }

    // Check for SYNC_ERROR
    if (syncState === "sync_error") {
        alerts.push("SYNC_ERROR");
    }

    // No alerts - show empty indicator
    if (alerts.length === 0) {
        return React.createElement("td", { className: "px-2 py-1 text-gray-400" }, "-");
    }

    return React.createElement(
        "td",
        { className: "px-2 py-1" },
        React.createElement(
            "div",
            { className: "flex flex-wrap gap-1" },
            alerts.map(function(code) {
                const config = ALERT_CONFIG[code] || { icon: "\u26A0\uFE0F", label: code, tooltip: code };
                return React.createElement(
                    "span",
                    {
                        key: code,
                        title: config.tooltip,
                        className: "text-xs cursor-help",
                    },
                    config.icon
                );
            })
        )
    );
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 90,
};
