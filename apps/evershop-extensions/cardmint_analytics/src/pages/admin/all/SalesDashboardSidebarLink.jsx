import { NavigationItemGroup } from "@components/admin/NavigationItemGroup";
import { ChartBarIcon } from "@heroicons/react/24/solid";
import React from "react";

export default function SalesDashboardSidebarLink() {
  return (
    <NavigationItemGroup
      id="salesDashboardMenuGroup"
      name="Analytics"
      items={[
        {
          Icon: ChartBarIcon,
          url: "/admin/sales-dashboard",
          title: "Sales Dashboard",
        },
      ]}
    />
  );
}

export const layout = {
  areaId: "adminMenu",
  sortOrder: 75,
};
