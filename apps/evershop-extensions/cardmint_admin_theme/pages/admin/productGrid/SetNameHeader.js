import { SortableHeader } from "@components/admin/grid/header/Sortable";
import React from "react";

export default function SetNameHeader() {
  return React.createElement(SortableHeader, { title: "Set", name: "cm_set_name" });
}

export const layout = {
  areaId: "productGridHeader",
  sortOrder: 12,
};
