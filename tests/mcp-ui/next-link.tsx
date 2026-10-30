import type { AnchorHTMLAttributes, ReactNode } from "react";

// The isolated renderer has no Next router. Only the brand's prefetch-disabled
// home link is adapted; product UI state, fetches and security helpers are real.
export default function FixtureLink({ children, href, prefetch: _prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: false; children: ReactNode }) {
  return <a href={href} {...props}>{children}</a>;
}
