import { DummyColumnHeader } from "@components/admin/grid/header/Dummy";
import React from "react";

export default function DeltaHeader() {
    return React.createElement(DummyColumnHeader, { title: "Δ Market" });
}

export const layout = {
    areaId: "productGridHeader",
    sortOrder: 16,
};
