import { DummyColumnHeader } from "@components/admin/grid/header/Dummy";
import React from "react";

export default function LivePriceHeader() {
    return React.createElement(DummyColumnHeader, { title: "Live (Store)" });
}

export const layout = {
    areaId: "productGridHeader",
    sortOrder: 15,
};
