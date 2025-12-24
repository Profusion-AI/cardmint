import React from "react";

/**
 * Compound Status Row - Shows two-part status: inventory status + sync state
 * Examples: [IN_STOCK] [LIVE], [SOLD] [HIDDEN], [SOLD] [LIVE] (with warning)
 */
export default function CompoundStatusRow({ areaProps }) {
    const row = areaProps?.row;

    // Determine inventory status
    // Priority: cmInventoryStatus > derive from qty
    const baseStatus = row?.cmInventoryStatus ?? null;
    const qty = row?.inventory?.qty;
    let itemStatus = baseStatus;

    // Map OUT_OF_STOCK to SOLD for clarity
    if (itemStatus === "OUT_OF_STOCK") {
        itemStatus = "SOLD";
    }

    // Fallback: derive from qty if no status field
    if (!itemStatus && typeof qty === "number") {
        itemStatus = qty > 0 ? "IN_STOCK" : "SOLD";
    }

    itemStatus = itemStatus ?? "UNKNOWN";

    // Determine sync state
    const syncState = row?.cmEvershopSyncState ?? "not_synced";

    // Status colors
    const statusColors = {
        IN_STOCK: "bg-green-100 text-green-800",
        RESERVED: "bg-orange-100 text-orange-800",
        SOLD: "bg-red-100 text-red-800",
        UNKNOWN: "bg-gray-100 text-gray-500",
    };

    // Sync state colors
    const syncColors = {
        evershop_live: "bg-green-100 text-green-800",
        evershop_hidden: "bg-gray-100 text-gray-600",
        vault_only: "bg-blue-100 text-blue-800",
        sync_error: "bg-red-100 text-red-800",
        not_synced: "bg-gray-100 text-gray-400",
    };

    // Sync state labels (shorter for display)
    const syncLabels = {
        evershop_live: "LIVE",
        evershop_hidden: "HIDDEN",
        vault_only: "VAULT",
        sync_error: "ERROR",
        not_synced: "-",
    };

    // Detect mismatch: SOLD but still LIVE (needs attention)
    const isMismatch = itemStatus === "SOLD" && syncState === "evershop_live";

    const statusClass = `px-2 py-0.5 text-xs font-medium rounded ${statusColors[itemStatus] || statusColors.UNKNOWN}`;
    const syncClass = `px-2 py-0.5 text-xs font-medium rounded ${syncColors[syncState] || syncColors.not_synced}`;

    return React.createElement(
        "td",
        { className: "px-2 py-1" },
        React.createElement(
            "div",
            { className: "flex gap-1 items-center" },
            React.createElement("span", { className: statusClass }, itemStatus),
            React.createElement("span", { className: syncClass }, syncLabels[syncState] || syncState),
            isMismatch && React.createElement(
                "span",
                { title: "Visibility mismatch - sold item still visible on storefront", className: "cursor-help" },
                "\u26A0\uFE0F"
            )
        )
    );
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 85,
};
