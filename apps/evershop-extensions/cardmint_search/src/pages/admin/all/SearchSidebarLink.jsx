import { NavigationItemGroup } from "@components/admin/NavigationItemGroup";
import { MagnifyingGlassIcon } from "@heroicons/react/24/solid";
import React from "react";

export default function SearchSidebarLink() {
  return (
    <NavigationItemGroup
      id="searchDashboardMenuGroup"
      name="Search"
      items={[
        {
          Icon: MagnifyingGlassIcon,
          url: "/admin/search-app",
          title: "Search Dashboard",
        },
      ]}
    />
  );
}

export const layout = {
  areaId: "adminMenu",
  sortOrder: 80,
};
