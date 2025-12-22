import { SortableHeader } from "@components/admin/grid/header/Sortable";
import React from "react";

export default function MarketPriceHeader() {
    return React.createElement(SortableHeader, { title: "Market (Internal)", name: "cm_market_price" });
}

export const layout = {
    areaId: "productGridHeader",
    sortOrder: 14,
};
