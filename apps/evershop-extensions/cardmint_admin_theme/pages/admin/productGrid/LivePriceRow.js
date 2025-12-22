import React, { useState, useCallback } from "react";

const MINIMUM_LISTING_PRICE = 0.79;
const MARGIN_SAFETY_THRESHOLD = 0.75; // 25% below market triggers modal

export default function LivePriceRow({ areaProps }) {
    const row = areaProps?.row;
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(row?.price?.regular?.value ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const marketPrice = row?.cmMarketPrice;
    const livePrice = row?.price?.regular?.value;

    const handleSave = useCallback(async () => {
        const numValue = parseFloat(value);

        // Validation
        if (isNaN(numValue) || !isFinite(numValue)) {
            setError("Invalid price");
            return;
        }
        if (numValue < MINIMUM_LISTING_PRICE) {
            setError(`Min: $${MINIMUM_LISTING_PRICE}`);
            return;
        }

        // Margin safety check
        if (marketPrice && numValue < marketPrice * MARGIN_SAFETY_THRESHOLD) {
            const confirmed = window.confirm(
                `Price $${numValue.toFixed(2)} is ${Math.round((1 - numValue / marketPrice) * 100)}% below market ($${marketPrice.toFixed(2)}).\n\nProceed anyway?`
            );
            if (!confirmed) {
                setValue(livePrice);
                setEditing(false);
                return;
            }
        }

        setSaving(true);
        setError(null);

        try {
            const response = await fetch(row.updateApi, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ price: numValue }),
            });

            if (!response.ok) throw new Error("Update failed");

            setEditing(false);
            // Trigger grid refresh
            window.location.reload();
        } catch (err) {
            setError(err.message);
            setValue(livePrice);
        } finally {
            setSaving(false);
        }
    }, [value, marketPrice, livePrice, row?.updateApi]);

    if (editing) {
        return React.createElement(
            "td",
            null,
            React.createElement(
                "div",
                { className: "flex items-center gap-1" },
                React.createElement("span", { className: "text-gray-400" }, "$"),
                React.createElement("input", {
                    type: "number",
                    step: "0.01",
                    min: MINIMUM_LISTING_PRICE,
                    value,
                    onChange: (e) => setValue(e.target.value),
                    onBlur: handleSave,
                    onKeyDown: (e) => e.key === "Enter" && handleSave(),
                    className: "w-20 px-1 py-0.5 border rounded text-sm",
                    autoFocus: true,
                    disabled: saving,
                }),
                error
                    ? React.createElement(
                        "span",
                        { className: "text-red-500 text-xs" },
                        error,
                    )
                    : null,
            ),
        );
    }

    return React.createElement(
        "td",
        {
            onClick: () => setEditing(true),
            className: "cursor-pointer hover:bg-gray-50",
            title: "Click to edit",
        },
        React.createElement(
            "div",
            { className: "flex items-center gap-1" },
            React.createElement("span", null, row?.price?.regular?.text ?? "—"),
            React.createElement(
                "span",
                { className: "text-gray-400 text-xs" },
                "✏️",
            ),
        ),
    );
}

export const layout = {
    areaId: "productGridRow",
    sortOrder: 15,
};
