import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Uploaded model bytes stream through route handlers; keep Next's default
  // (no body-parser size cap on route handlers) so MAX_UPLOAD_MB is the only
  // limit that matters, and it is enforced in the API.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Stop browsers from re-interpreting user-supplied uploads as HTML.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
