import React from "react";

export default function DeltaRow({ areaProps }) {
    const row = areaProps?.row;
    const marketPrice = row?.cmMarketPrice;
    const livePrice = row?.price?.regular?.value;

    if (!marketPrice || !livePrice) {
        return React.createElement("td", { className: "text-gray-400" }, "—");
    }

    const deltaAbs = livePrice - marketPrice;
    const deltaPct = ((livePrice / marketPrice) - 1) * 100;

    // Color coding: green = above market, yellow = near market, red = below market
    const colorClass = deltaPct >= 10
        ? "text-green-600"
        : deltaPct >= -10
            ? "text-yellow-600"
            : "text-red-600";

    const sign = deltaAbs >= 0 ? "+" : "";

    return React.createElement(
        "td",
        { className: colorClass },
        React.createElement(
            "div",
            { className: "text-sm" },
            React.createElement("span", null, `${sign}$${deltaAbs.toFixed(2)}`),
            React.createElement(
                "span",
                { className: "ml-1 text-xs" },
                `(${sign}${deltaPct.toFixed(0)}%)`,
            ),
        ),
    );
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 16,
};
