import React from "react";

export default function AlertsHeader() {
    return React.createElement(
        "th",
        { className: "px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" },
        "Alerts"
    );
}

export const layout = {
    areaId: "productGridHeader",
    sortOrder: 90,
};
