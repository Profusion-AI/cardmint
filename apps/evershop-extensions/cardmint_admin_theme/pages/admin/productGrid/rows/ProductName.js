// Re-export from core EverShop since we can't import across package exports boundary
import React from 'react';

export function ProductNameRow({ url, name }) {
    return (React.createElement("td", null,
        React.createElement("div", null,
            React.createElement("a", { className: "hover:underline font-semibold", href: url }, name))));
}
