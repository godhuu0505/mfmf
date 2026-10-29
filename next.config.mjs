/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" } : {}),
};

// Privacy-first telemetry uses Next's instrumentation hook and explicit capture.
// No Sentry build plugin: no automatic browser/request instrumentation, source
// maps, build credentials or build-time telemetry are uploaded or injected.
export default nextConfig;
