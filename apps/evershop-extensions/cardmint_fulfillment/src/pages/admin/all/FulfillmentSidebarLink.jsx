import { NavigationItemGroup } from "@components/admin/NavigationItemGroup";
import { TruckIcon } from "@heroicons/react/24/solid";
import React from "react";

/**
 * Fulfillment section in admin sidebar navigation
 * Uses EverShop's NavigationItemGroup pattern for proper rendering
 */
export default function FulfillmentSidebarLink() {
  return (
    <NavigationItemGroup
      id="fulfillmentMenuGroup"
      name="Fulfillment"
      items={[
        {
          Icon: TruckIcon,
          url: "/admin/fulfillment",
          title: "Shipping Dashboard",
        },
      ]}
    />
  );
}

export const layout = {
  areaId: "adminMenu",
  sortOrder: 70,
};
