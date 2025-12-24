import React from "react";

export default function CompoundStatusHeader() {
    return React.createElement(
        "th",
        { className: "px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" },
        "Status"
    );
}

export const layout = {
    areaId: "productGridHeader",
    sortOrder: 85,
};
