import type { ReactNode } from "react";

import "./prototype.css";

// PROTOTYPE — throwaway frontend shell for the Live Preview linking fixture (#85).
const Layout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default Layout;
