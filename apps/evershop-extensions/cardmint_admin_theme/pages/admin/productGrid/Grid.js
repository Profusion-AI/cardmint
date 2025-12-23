// CardMint extension: Copy of EverShop core Grid.js with cm* fields added to query
// This is necessary because @evershop/evershop's exports field doesn't expose internal page components

import { Card } from '@components/admin/Card';
import { Filter } from '@components/admin/grid/Filter';
import { DummyColumnHeader } from '@components/admin/grid/header/Dummy';
import { SortableHeader } from '@components/admin/grid/header/Sortable';
import { Pagination } from '@components/admin/grid/Pagination';
import { Thumbnail } from '@components/admin/grid/Thumbnail.js';
import { Status } from '@components/admin/Status.js';
import Area from '@components/common/Area';
import { Form } from '@components/common/form/Form.js';
import { InputField } from '@components/common/form/InputField.js';
import { useAlertContext } from '@components/common/modal/Alert';
import axios from 'axios';
import PropTypes from 'prop-types';
import React, { useState } from 'react';
import { ProductNameRow } from './rows/ProductName.js';

function Actions({ products = [], selectedIds = [] }) {
    const { openAlert, closeAlert } = useAlertContext();
    const [isLoading, setIsLoading] = useState(false);
    const updateProducts = async (status) => {
        setIsLoading(true);
        const promises = products
            .filter((product) => selectedIds.includes(product.uuid))
            .map((product) => axios.patch(product.updateApi, {
            status
        }));
        await Promise.all(promises);
        setIsLoading(false);
        // Refresh the page
        window.location.reload();
    };
    const deleteProducts = async () => {
        setIsLoading(true);
        const promises = products
            .filter((product) => selectedIds.includes(product.uuid))
            .map((product) => axios.delete(product.deleteApi));
        await Promise.all(promises);
        setIsLoading(false);
        // Refresh the page
        window.location.reload();
    };
    const actions = [
        {
            name: 'Disable',
            onAction: () => {
                openAlert({
                    heading: `Disable ${selectedIds.length} products`,
                    content: 'Are you sure?',
                    primaryAction: {
                        title: 'Cancel',
                        onAction: closeAlert,
                        variant: 'primary'
                    },
                    secondaryAction: {
                        title: 'Disable',
                        onAction: async () => {
                            await updateProducts(0);
                        },
                        variant: 'critical',
                        isLoading: false
                    }
                });
            }
        },
        {
            name: 'Enable',
            onAction: () => {
                openAlert({
                    heading: `Enable ${selectedIds.length} products`,
                    content: 'Are you sure?',
                    primaryAction: {
                        title: 'Cancel',
                        onAction: closeAlert,
                        variant: 'primary'
                    },
                    secondaryAction: {
                        title: 'Enable',
                        onAction: async () => {
                            await updateProducts(1);
                        },
                        variant: 'critical',
                        isLoading: false
                    }
                });
            }
        },
        {
            name: 'Delete',
            onAction: () => {
                openAlert({
                    heading: `Delete ${selectedIds.length} products`,
                    content: React.createElement("div", null, "Can't be undone"),
                    primaryAction: {
                        title: 'Cancel',
                        onAction: closeAlert,
                        variant: 'primary'
                    },
                    secondaryAction: {
                        title: 'Delete',
                        onAction: async () => {
                            await deleteProducts();
                        },
                        variant: 'critical',
                        isLoading
                    }
                });
            }
        }
    ];
    return (React.createElement("tr", null,
        selectedIds.length === 0 && null,
        selectedIds.length > 0 && (React.createElement("td", { style: { borderTop: 0 }, colSpan: "100" },
            React.createElement("div", { className: "inline-flex border border-divider rounded justify-items-start" },
                React.createElement("a", { href: "#", className: "font-semibold pt-2 pb-2 pl-4 pr-4" },
                    selectedIds.length,
                    " selected"),
                actions.map((action, i) => (React.createElement("a", { key: i, href: "#", onClick: (e) => {
                        e.preventDefault();
                        action.onAction();
                    }, className: "font-semibold pt-2 pb-2 pl-4 pr-4 block border-l border-divider self-center" },
                    React.createElement("span", null, action.name)))))))));
}
Actions.propTypes = {
    selectedIds: PropTypes.arrayOf(PropTypes.string).isRequired,
    products: PropTypes.arrayOf(PropTypes.shape({
        uuid: PropTypes.string.isRequired,
        updateApi: PropTypes.string.isRequired,
        deleteApi: PropTypes.string.isRequired
    })).isRequired
};

export default function ProductGrid({ products: { items: products, total, currentFilters = [] } }) {
    const page = currentFilters.find((filter) => filter.key === 'page')
        ? parseInt(currentFilters.find((filter) => filter.key === 'page').value, 10)
        : 1;
    const limit = currentFilters.find((filter) => filter.key === 'limit')
        ? parseInt(currentFilters.find((filter) => filter.key === 'limit').value, 10)
        : 20;
    const [selectedRows, setSelectedRows] = useState([]);
    return (React.createElement(Card, null,
        React.createElement(Card.Session, { title: React.createElement(Form, { submitBtn: false, id: "productGridFilter" },
                React.createElement("div", { className: "flex gap-5 justify-center items-center" },
                    React.createElement(Area, { id: "productGridFilter", noOuter: true, coreComponents: [
                            {
                                component: {
                                    default: () => {
                                        var _a;
                                        return (React.createElement(InputField, { name: "keyword", placeholder: "Search", defaultValue: (_a = currentFilters.find((f) => f.key === 'keyword')) === null || _a === void 0 ? void 0 : _a.value, onKeyPress: (e) => {
                                                var _a;
                                                // If the user press enter, we should submit the form
                                                if (e.key === 'Enter') {
                                                    const url = new URL(document.location);
                                                    const keyword = (_a = e.target) === null || _a === void 0 ? void 0 : _a.value;
                                                    if (keyword) {
                                                        url.searchParams.set('keyword', keyword);
                                                    }
                                                    else {
                                                        url.searchParams.delete('keyword');
                                                    }
                                                    window.location.href = url;
                                                }
                                            } }));
                                    }
                                },
                                sortOrder: 5
                            },
                            {
                                component: {
                                    default: () => (React.createElement(Filter, { options: [
                                            {
                                                label: 'Enabled',
                                                value: '1',
                                                onSelect: () => {
                                                    const url = new URL(document.location);
                                                    url.searchParams.set('status', 1);
                                                    window.location.href = url;
                                                }
                                            },
                                            {
                                                label: 'Disabled',
                                                value: '0',
                                                onSelect: () => {
                                                    const url = new URL(document.location);
                                                    url.searchParams.set('status', 0);
                                                    window.location.href = url;
                                                }
                                            }
                                        ], selectedOption: currentFilters.find((f) => f.key === 'status')
                                            ? currentFilters.find((f) => f.key === 'status')
                                                .value === '1'
                                                ? 'Enabled'
                                                : 'Disabled'
                                            : undefined, title: "Status" }))
                                },
                                sortOrder: 10
                            },
                            {
                                component: {
                                    default: () => (React.createElement(Filter, { options: [
                                            {
                                                label: 'Simple',
                                                value: '1',
                                                onSelect: () => {
                                                    const url = new URL(document.location);
                                                    url.searchParams.set('type', 'simple');
                                                    window.location.href = url;
                                                }
                                            },
                                            {
                                                label: 'Configurable',
                                                value: '0',
                                                onSelect: () => {
                                                    const url = new URL(document.location);
                                                    url.searchParams.set('type', 'configurable');
                                                    window.location.href = url;
                                                }
                                            }
                                        ], selectedOption: currentFilters.find((f) => f.key === 'type')
                                            ? currentFilters.find((f) => f.key === 'type')
                                                .value
                                            : undefined, title: "Product type" }))
                                },
                                sortOrder: 15
                            }
                        ], currentFilters: currentFilters }))), actions: [
                {
                    variant: 'interactive',
                    name: 'Clear filter',
                    onAction: () => {
                        const url = new URL(document.location);
                        url.search = '';
                        window.location.href = url.href;
                    }
                }
            ] }),
        React.createElement("table", { className: "listing sticky" },
            React.createElement("thead", null,
                React.createElement("tr", null,
                    React.createElement("th", { className: "align-bottom" },
                        React.createElement("div", { className: "form-field mb-0" },
                            React.createElement("input", { type: "checkbox", onChange: (e) => {
                                    if (e.target.checked) {
                                        setSelectedRows(products.map((p) => p.uuid));
                                    }
                                    else {
                                        setSelectedRows([]);
                                    }
                                } }))),
                    React.createElement(Area, { id: "productGridHeader", noOuter: true, coreComponents: [
                            {
                                component: {
                                    default: () => (React.createElement("th", { className: "column" },
                                        React.createElement("div", { className: "table-header id-header" },
                                            React.createElement("div", { className: "font-medium uppercase text-xs" },
                                                React.createElement("span", null, "Thumbnail")))))
                                },
                                sortOrder: 5
                            },
                            {
                                component: {
                                    default: () => (React.createElement(SortableHeader, { title: "Name", name: "name", currentFilters: currentFilters }))
                                },
                                sortOrder: 10
                            },
                            {
                                component: {
                                    default: () => (React.createElement(SortableHeader, { title: "Price", name: "price", currentFilters: currentFilters }))
                                },
                                sortOrder: 15
                            },
                            {
                                component: {
                                    default: () => React.createElement(DummyColumnHeader, { title: "SKU" })
                                },
                                sortOrder: 20
                            },
                            {
                                component: {
                                    default: () => (React.createElement(SortableHeader, { title: "Stock", name: "qty", currentFilters: currentFilters }))
                                },
                                sortOrder: 25
                            },
                            {
                                component: {
                                    default: () => (React.createElement(SortableHeader, { title: "Status", name: "status", currentFilters: currentFilters }))
                                },
                                sortOrder: 30
                            }
                        ] }))),
            React.createElement("tbody", null,
                React.createElement(Actions, { products: products, selectedIds: selectedRows, setSelectedRows: setSelectedRows }),
                products.map((p) => (React.createElement("tr", { key: p.uuid },
                    React.createElement("td", null,
                        React.createElement("div", { className: "form-field mb-0" },
                            React.createElement("input", { type: "checkbox", checked: selectedRows.includes(p.uuid), onChange: (e) => {
                                    if (e.target.checked) {
                                        setSelectedRows(selectedRows.concat([p.uuid]));
                                    }
                                    else {
                                        setSelectedRows(selectedRows.filter((row) => row !== p.uuid));
                                    }
                                } }))),
                    React.createElement(Area, { id: "productGridRow", row: p, noOuter: true, selectedRows: selectedRows, setSelectedRows: setSelectedRows, coreComponents: [
                            {
                                component: {
                                    default: () => {
                                        var _a;
                                        return (React.createElement(Thumbnail, { src: (_a = p.image) === null || _a === void 0 ? void 0 : _a.url, name: p.name }));
                                    }
                                },
                                sortOrder: 5
                            },
                            {
                                component: {
                                    default: () => (React.createElement(ProductNameRow, { id: "name", name: p.name, url: p.editUrl }))
                                },
                                sortOrder: 10
                            },
                            {
                                component: {
                                    default: () => { var _a; return React.createElement("td", null, (_a = p.price) === null || _a === void 0 ? void 0 : _a.regular.text); }
                                },
                                sortOrder: 15
                            },
                            {
                                component: {
                                    default: () => React.createElement("td", null, p.sku)
                                },
                                sortOrder: 20
                            },
                            {
                                component: {
                                    default: () => { var _a; return React.createElement("td", null, (_a = p.inventory) === null || _a === void 0 ? void 0 : _a.qty); }
                                },
                                sortOrder: 25
                            },
                            {
                                component: {
                                    default: ({ areaProps }) => (React.createElement(Status, { id: "status", status: parseInt(p.status, 10) }))
                                },
                                sortOrder: 30
                            }
                        ] })))))),
        products.length === 0 && (React.createElement("div", { className: "flex w-full justify-center" }, "There is no product to display")),
        React.createElement(Pagination, { total: total, limit: limit, page: page })));
}

ProductGrid.propTypes = {
    products: PropTypes.shape({
        items: PropTypes.arrayOf(PropTypes.shape({
            productId: PropTypes.number,
            uuid: PropTypes.string,
            name: PropTypes.string,
            image: PropTypes.shape({
                thumb: PropTypes.string
            }),
            sku: PropTypes.string,
            status: PropTypes.number,
            inventory: PropTypes.shape({
                qty: PropTypes.number
            }),
            price: PropTypes.shape({
                regular: PropTypes.shape({
                    value: PropTypes.number,
                    text: PropTypes.string
                })
            }),
            editUrl: PropTypes.string,
            updateApi: PropTypes.string,
            deleteApi: PropTypes.string,
            // CardMint custom fields
            cmSetName: PropTypes.string,
            cmVariant: PropTypes.string,
            cmMarketPrice: PropTypes.number,
            cmPricingSource: PropTypes.string,
            cmPricingStatus: PropTypes.string,
            cmPricingUpdatedAt: PropTypes.string,
            cmProductUid: PropTypes.string,
            cmInventoryStatus: PropTypes.string
        })),
        total: PropTypes.number,
        currentFilters: PropTypes.arrayOf(PropTypes.shape({
            key: PropTypes.string,
            operation: PropTypes.string,
            value: PropTypes.string
        }))
    }).isRequired
};

export const layout = {
    areaId: 'content',
    sortOrder: 20
};

// CardMint: Extended query with cm* fields for custom admin columns
export const query = `
  query Query($filters: [FilterInput]) {
    products (filters: $filters) {
      items {
        productId
        uuid
        name
        image {
          url
          alt
        }
        sku
        status
        inventory {
          qty
        }
        price {
          regular {
            value
            text
          }
        }
        editUrl
        updateApi
        deleteApi
        cmSetName
        cmVariant
        cmMarketPrice
        cmPricingSource
        cmPricingStatus
        cmPricingUpdatedAt
        cmProductUid
        cmInventoryStatus
      }
      total
      currentFilters {
        key
        operation
        value
      }
    }
    newProductUrl: url(routeId: "productNew")
  }
`;

export const variables = `
{
  filters: getContextValue('filtersFromUrl')
}`;
