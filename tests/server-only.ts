import { vi } from "vitest";

// These tests intentionally execute Server Actions outside a Next.js RSC runtime.
// Production's client/server import boundary remains enforced by next build.
vi.mock("server-only", () => ({}));
