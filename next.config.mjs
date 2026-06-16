/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // 写真（長辺1600px・JPEG）を複数枚添付すると Server Action の
      // 既定ボディ上限 1MB を超えて 500 になるため引き上げる。
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
