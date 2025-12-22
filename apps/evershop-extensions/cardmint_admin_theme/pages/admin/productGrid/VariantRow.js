import React from "react";

export default function VariantRow({ areaProps }) {
    const variant = areaProps?.row?.cmVariant ?? "";
    return React.createElement("td", { className: "text-sm text-gray-600" }, variant);
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 13,
};
