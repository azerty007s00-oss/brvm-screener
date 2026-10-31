import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Les justificatifs de versement transitent par une Server Action, encodes en
     * base64. Le plafond par defaut est de 1 Mo : une photo de recu le depasse,
     * et le refus serait silencieux pour le membre.
     */
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
