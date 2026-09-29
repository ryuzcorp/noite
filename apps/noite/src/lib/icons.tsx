interface IconProps {
  class?: string;
  /** Pixel width/height. Each icon defaults to the size its old SVG string
   * hard-coded; a sizing class (`h-5 w-5`) still wins over it via CSS. */
  size?: number;
}

// Ilha's SVGAttributes type omits rx/ry (corner radius), so those ride in
// via spread, which the runtime applies with setAttribute generically.
const rx = (v: number) => ({ rx: v });

// Explicit width/height: without them an inline <svg> is sized by CSS
// alone, and Tailwind's preflight (`max-width: 100%; height: auto`)
// stretches it to fill the containing box.
const base = (p: IconProps, size: number) => ({
  "aria-hidden": true as const,
  class: p.class,
  fill: "none",
  height: p.size ?? size,
  stroke: "currentColor",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "stroke-width": 2,
  viewBox: "0 0 24 24",
  width: p.size ?? size,
});

export const ChevronRight = (p: IconProps) => (
  <svg {...base(p, 20)}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const ChevronDown = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const ChevronUp = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="m18 15-6-6-6 6" />
  </svg>
);

export const ArrowLeft = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </svg>
);

export const ArrowUpRight = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M7 7h10v10" />
    <path d="M7 17 17 7" />
  </svg>
);

export const Copy = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <rect width="14" height="14" x="8" y="8" {...rx(2)} {...{ ry: 2 }} />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

export const Check = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const CloudUpload = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M12 13v8" />
    <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
    <path d="m8 17 4-4 4 4" />
  </svg>
);

export const Pencil = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </svg>
);

export const Trash = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

export const Info = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const Code = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </svg>
);

export const Menu = (p: IconProps) => (
  <svg {...base(p, 20)}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
  </svg>
);

export const Pause = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <rect width="4" height="16" x="6" y="4" />
    <rect width="4" height="16" x="14" y="4" />
  </svg>
);

export const Play = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </svg>
);

export const List = (p: IconProps) => (
  <svg {...base(p, 20)}>
    <rect width="7" height="7" x="3" y="3" {...rx(1)} />
    <rect width="7" height="7" x="3" y="14" {...rx(1)} />
    <path d="M14 4h7m-7 5h7m-7 6h7m-7 5h7" />
  </svg>
);
