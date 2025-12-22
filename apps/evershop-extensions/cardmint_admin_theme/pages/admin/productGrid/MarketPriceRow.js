import React from "react";

export default function MarketPriceRow({ areaProps }) {
    const row = areaProps?.row;
    const marketPrice = row?.cmMarketPrice;
    const status = row?.cmPricingStatus ?? "missing";

    const statusColors = {
        fresh: "bg-green-100 text-green-800",
        stale: "bg-yellow-100 text-yellow-800",
        missing: "bg-red-100 text-red-800",
    };

    const priceText = marketPrice != null ? `$${marketPrice.toFixed(2)}` : "—";
    const pillClass = `px-1.5 py-0.5 rounded text-xs ${statusColors[status] || "bg-gray-100 text-gray-800"}`;

    return React.createElement(
        "td",
        null,
        React.createElement(
            "div",
            { className: "flex items-center gap-2" },
            React.createElement("span", null, priceText),
            React.createElement("span", { className: pillClass }, status),
        ),
    );
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 14,
};
