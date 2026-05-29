/**
 * Branding & runtime configuration.
 *
 * Everything that distinguishes this fork from a generic image optimizer
 * lives here: copy, logo, color palette, processing tuning, and limits.
 * Edit this file to rebrand the app for another team.
 *
 * After editing, restart `npm run dev`.
 */
export const branding = {
  /** Visible copy across the app. */
  brand: {
    name: "<D3vAya/>",
    product: "Adelgazapix",
    /** Optional: makes the product title in the header clickable (opens in new tab). */
    productHref: "https://github.com/D3vaya/adelgazapix",
    tagline:
      "Tus PNG entran gordos y salen fit. Sharp + WebP, sin sudar — cardio para imágenes, deploy para ti.",
    badge: "side project",
    footer: {
      right: "jcayala.dev",
      /** Optional: makes `right` (and the footer logo) a link. */
      rightHref: "https://www.jcayala.dev/",
      /** Tiny prefix shown before the signature ("by", "—", "made by", etc.). */
      signaturePrefix: "by",
    },
    /** Used for <html lang="…"> and screen-reader hints. */
    locale: "es",
  },

  /**
   * Logo / personal mark.
   * Drop your asset into `public/` and update `src` accordingly.
   *
   * `header.show`: render it in the page header (true for wordmarks).
   * `footer.show`: render it next to footer.right (true for avatar-style signatures).
   * `className`s tune the shape (rounded for portraits, h-7 w-auto for wordmarks).
   */
  logo: {
    src: "/sign.png",
    alt: "D3v",
    width: 48,
    height: 48,
    header: {
      show: false,
      className: "h-7 w-auto",
    },
    footer: {
      show: true,
      className:
        "h-5 w-5 shrink-0 rounded-full object-cover ring-1 ring-brand-500/30",
    },
  },

  /**
   * Brand color scale (50 lightest → 950 darkest).
   * Accessible from Tailwind as `bg-brand-500`, `text-brand-300`, etc.
   * Generate a complete scale at https://uicolors.app/create from any seed hex.
   *
   * Current: electric cyan — matches jcayala.dev terminal/CLI aesthetic.
   */
  palette: {
    50: "#ecfeff",
    100: "#cffafe",
    200: "#a5f3fc",
    300: "#67e8f9",
    400: "#22d3ee",
    500: "#06b6d4",
    600: "#0891b2",
    700: "#0e7490",
    800: "#155e75",
    900: "#164e63",
    950: "#083344",
  },

  /** Page background and primary foreground color. */
  surface: {
    background: "#070a14",
    foreground: "#e8f4ff",
  },

  /** Image-processing knobs passed to Sharp + queue/upload limits. */
  processing: {
    /** WebP quality (1–100). Lower = smaller files, more visible artifacts. */
    quality: 75,
    /** WebP encode effort (0–6). Higher = smaller files, slower CPU. */
    effort: 6,
    /** Hard cap per file (server rejects with HTTP 413 above this). */
    maxFileBytes: 25 * 1024 * 1024,
    /** Soft cap for files queued in a single session (client-side). */
    maxFiles: 100,
    /** Parallel uploads in flight on the client. */
    maxConcurrent: 4,
    /** Reject images wider/taller than this many pixels (HTTP 422). */
    maxDimension: 12000,
    /** Accepted Content-Type values (server enforces; client filters). */
    allowedMime: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/gif",
      "image/tiff",
      "image/svg+xml",
      "image/heic",
      "image/heif",
    ],
  },
} as const;

export type Branding = typeof branding;

/**
 * Tailwind reads brand colors through CSS variables in the form
 * `rgb(var(--brand-500) / <alpha-value>)`. The variables must hold an RGB
 * triple ("168 85 247"), which we generate from the hex palette above.
 */
export function hexToRgbTriple(hex: string): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const num = parseInt(full, 16);
  return `${(num >> 16) & 255} ${(num >> 8) & 255} ${num & 255}`;
}

/** CSS to inject in the document <head> so Tailwind utilities resolve. */
export function brandingCssVariables(): string {
  const palette = Object.entries(branding.palette)
    .map(([k, v]) => `--brand-${k}:${hexToRgbTriple(v)};`)
    .join("");
  const surface =
    `--background:${branding.surface.background};` +
    `--foreground:${branding.surface.foreground};`;
  return `:root{${palette}${surface}}`;
}
