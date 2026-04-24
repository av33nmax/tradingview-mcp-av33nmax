import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
        }}
      >
        <div
          style={{
            position: "relative",
            width: 110,
            height: 110,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              position: "absolute",
              width: 96,
              height: 96,
              border: "8px solid white",
              borderRadius: "50%",
            }}
          />
          <div style={{ position: "absolute", width: 124, height: 8, background: "white", borderRadius: 4 }} />
          <div style={{ position: "absolute", width: 8, height: 124, background: "white", borderRadius: 4 }} />
          <div
            style={{
              position: "absolute",
              width: 16,
              height: 16,
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
