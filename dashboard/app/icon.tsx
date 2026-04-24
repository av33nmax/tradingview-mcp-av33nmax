import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 256, height: 256 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #f97316, #e11d48)",
          borderRadius: 48,
        }}
      >
        {/* Crosshair: circle + cross lines */}
        <div
          style={{
            position: "relative",
            width: 160,
            height: 160,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              position: "absolute",
              width: 140,
              height: 140,
              border: "12px solid white",
              borderRadius: "50%",
            }}
          />
          <div style={{ position: "absolute", width: 180, height: 12, background: "white", borderRadius: 6 }} />
          <div style={{ position: "absolute", width: 12, height: 180, background: "white", borderRadius: 6 }} />
          <div
            style={{
              position: "absolute",
              width: 24,
              height: 24,
              background: "white",
              borderRadius: "50%",
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
