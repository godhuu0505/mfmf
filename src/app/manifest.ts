import type { MetadataRoute } from "next";

// /manifest.webmanifest を生成する (Next.js metadata route)。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "mfmf | ペット保育園記録",
    short_name: "mfmf",
    description: "ペット保育園からの記録と写真を残すアプリ",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f8fafc",
    theme_color: "#0f172a",
    lang: "ja",
    categories: ["lifestyle", "utilities"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
