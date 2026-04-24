import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cro$$hair ZeroOne",
    short_name: "Cro$$hair",
    description: "Systematic 0DTE trader's co-pilot",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["finance", "productivity", "utilities"],
    icons: [
      {
        src: "/icon",
        sizes: "any",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
