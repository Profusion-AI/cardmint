import React from "react";

export default function SetNameRow({ areaProps }) {
  const row = areaProps?.row;
  const setName = row?.category?.name ?? row?.cmSetName ?? "";
  return React.createElement("td", null, setName);
}

export const layout = {
  areaId: "productGridRow",
  sortOrder: 12,
};
