import React from "react";
import type { ReactNode } from "react";

export default function FrontendLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          color: "#252333",
          background: "#faf9f6",
        }}
      >
        {children}
      </body>
    </html>
  );
}
