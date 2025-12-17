import React, { useEffect } from "react";

function attachSmartFilter() {
  const input =
    document.querySelector('input[placeholder*="ategor"]') ||
    document.querySelector('input[placeholder*="ategory"]') ||
    document.querySelector('input[aria-label*="ategor"]');

  if (!input) {
    return null;
  }

  const form = input.closest("form") || document;
  const optionLabels = Array.from(form.querySelectorAll("label")).filter((label) =>
    label.querySelector('input[type="checkbox"], input[type="radio"]'),
  );

  if (optionLabels.length === 0) {
    return null;
  }

  const noResultsBanner = document.createElement("div");
  noResultsBanner.textContent = "No categories match your search.";
  noResultsBanner.style.marginTop = "8px";
  noResultsBanner.style.color = "#6b7280";
  noResultsBanner.style.fontSize = "12px";
  noResultsBanner.style.display = "none";
  input.parentElement?.appendChild(noResultsBanner);

  const handleInput = () => {
    const query = input.value.trim().toLowerCase();
    let matches = 0;

    optionLabels.forEach((label) => {
      const text = (label.textContent || "").toLowerCase();
      const match = query === "" || text.includes(query);
      label.style.display = match ? "" : "none";
      if (match) {
        matches += 1;
      }
    });

    noResultsBanner.style.display = matches === 0 ? "" : "none";
  };

  input.addEventListener("input", handleInput);
  handleInput();

  return () => {
    input.removeEventListener("input", handleInput);
    optionLabels.forEach((label) => {
      label.style.display = "";
    });
    noResultsBanner.remove();
  };
}

export default function CategorySmartFilter() {
  useEffect(() => {
    let cleanup = attachSmartFilter();

    const observer = new MutationObserver(() => {
      if (cleanup) return;
      cleanup = attachSmartFilter();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      cleanup?.();
    };
  }, []);

  return null; // Pure behavior injection
}

export const layout = {
  areaId: "body",
  sortOrder: 3,
};
