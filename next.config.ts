import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {},

  experimental: {
    optimizePackageImports: [
      'lucide-react',
      'katex',
      'docx',
      'pptxgenjs',
      'xlsx',
      'rehype-katex',
      'remark-math',
      'react-markdown',
    ],
  },

  async redirects() {
    return [
      {
        source: '/',
        destination: '/home',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;


