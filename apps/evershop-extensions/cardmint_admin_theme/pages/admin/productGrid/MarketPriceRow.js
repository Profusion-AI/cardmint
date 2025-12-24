import React from "react";

/**
 * Build PriceCharting search URL from card name and set number
 */
function buildPriceChartingUrl(name, variant, sku) {
    // Try to extract set number (e.g., "064/102") from variant or sku
    const variantOrSku = variant || sku || "";
    const setNumberMatch = variantOrSku.match(/\b\d{1,3}\/\d{1,3}\b/);
    const setNumber = setNumberMatch ? setNumberMatch[0] : "";

    // Build query: "card name set-number"
    const queryText = [name, setNumber].filter(Boolean).join(" ").trim();
    if (!queryText) return null;

    return `https://www.pricecharting.com/search-products?type=prices&ignore-preferences=true&q=${encodeURIComponent(queryText)}&go=Go`;
}

export default function MarketPriceRow({ areaProps }) {
    const row = areaProps?.row;
    const marketPrice = row?.cmMarketPrice;
    const status = row?.cmPricingStatus ?? "missing";

    // Build Research URL
    const researchUrl = buildPriceChartingUrl(row?.name, row?.cmVariant, row?.sku);

    const statusColors = {
        fresh: "bg-green-100 text-green-800",
        stale: "bg-yellow-100 text-yellow-800",
        missing: "bg-red-100 text-red-800",
    };

    const priceText = marketPrice != null ? `$${marketPrice.toFixed(2)}` : "-";
    const pillClass = `px-1.5 py-0.5 rounded text-xs ${statusColors[status] || "bg-gray-100 text-gray-800"}`;
    const researchPillClass = "px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-800 hover:bg-blue-200 cursor-pointer no-underline";

    return React.createElement(
        "td",
        null,
        React.createElement(
            "div",
            { className: "flex items-center gap-2" },
            React.createElement("span", null, priceText),
            React.createElement("span", { className: pillClass }, status),
            researchUrl && React.createElement(
                "a",
                {
                    href: researchUrl,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    className: researchPillClass,
                    title: "Search PriceCharting for this card",
                },
                "Research"
            )
        )
    );
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 14,
};
