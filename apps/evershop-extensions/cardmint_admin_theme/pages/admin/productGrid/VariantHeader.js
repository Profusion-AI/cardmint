import { SortableHeader } from "@components/admin/grid/header/Sortable";
import React from "react";

export default function VariantHeader() {
    return React.createElement(SortableHeader, { title: "Variant", name: "cm_variant" });
}

export const layout = {
    areaId: "productGridHeader",
    sortOrder: 13,
};
