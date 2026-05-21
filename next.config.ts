import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["100.93.7.126"],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
