import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";

import "./styles.css";

const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

const posthogOptions = {
  api_host: POSTHOG_HOST || "https://us.i.posthog.com",
  defaults: "2025-11-30",
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: "[data-ph-no-capture]",
  },
  capture_pageview: true,
  capture_pageleave: true,
} as const;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {POSTHOG_KEY ? (
      <PostHogProvider apiKey={POSTHOG_KEY} options={posthogOptions}>
        <App />
      </PostHogProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
