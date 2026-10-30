/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return ["/oauth/consent/:path*", "/connections", "/api/oauth/:path*", "/login"].map(source => ({
      source,
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
      ],
    }));
  },
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" } : {}),
};

// Privacy-first telemetry uses Next's instrumentation hook and explicit capture.
// No Sentry build plugin: no automatic browser/request instrumentation, source
// maps, build credentials or build-time telemetry are uploaded or injected.
export default nextConfig;
