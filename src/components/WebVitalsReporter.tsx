"use client";

import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { browserReporter } from "@/lib/telemetry/client";

// No browser SDK, DSN, exception details, resource URLs or DOM data are collected.
export default function WebVitalsReporter() {
  useReportWebVitals((metric) => { void browserReporter().vital(metric); });
  useEffect(() => {
    const error = () => { void browserReporter().error("unhandled-error"); };
    const rejection = () => { void browserReporter().error("unhandled-rejection"); };
    window.addEventListener("error", error);
    window.addEventListener("unhandledrejection", rejection);
    return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
  }, []);
  return null;
}
