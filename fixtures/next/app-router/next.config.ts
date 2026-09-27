import type { NextConfig } from 'next';

// 합성 fixture: basePath·trailingSlash 없이 기본값을 쓴다.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [];
  },
};

export default nextConfig;
