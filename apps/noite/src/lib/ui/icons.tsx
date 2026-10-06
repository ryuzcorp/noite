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

export const X = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const Key = (p: IconProps) => (
  <svg {...base(p, 20)}>
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
  </svg>
);

export const Heart = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>
);

export const MessageCircle = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  </svg>
);

export const Star = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M11.5 2.3a.5.5 0 0 1 1 0l2.3 4.7 5.2.8a.5.5 0 0 1 .3.9l-3.8 3.6.9 5.2a.5.5 0 0 1-.8.6L12 15.6l-4.6 2.5a.5.5 0 0 1-.8-.6l.9-5.2-3.8-3.6a.5.5 0 0 1 .3-.9l5.2-.8Z" />
  </svg>
);

export const ChevronLeft = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
);

export const Database = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <ellipse cx="12" cy="6" {...rx(8)} {...{ ry: 3 }} />
    <path d="M4 6v6a8 3 0 0 0 16 0V6" />
    <path d="M4 12v6a8 3 0 0 0 16 0v-6" />
  </svg>
);

export const Table = (p: IconProps) => (
  <svg {...base(p, 20)}>
    <rect height="18" width="18" x="3" y="3" {...rx(2)} {...{ ry: 2 }} />
    <path d="M3 10h18" />
    <path d="M10 3v18" />
  </svg>
);

export const Search = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <circle cx="10" cy="10" r="7" />
    <path d="m21 21-6-6" />
  </svg>
);

export const Filter = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="M4 4h16v2.17a2 2 0 0 1-.59 1.42L15 12v7l-6 2v-8.5L4.52 7.59A2 2 0 0 1 4 6.17z" />
  </svg>
);

export const ArrowUpDown = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <path d="m8 9 4-4 4 4" />
    <path d="m16 15-4 4-4-4" />
  </svg>
);

export const Refresh = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4" />
    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
  </svg>
);

export const Plus = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

export const Lock = (p: IconProps) => (
  <svg {...base(p, 14)}>
    <rect height="10" width="14" x="5" y="11" {...rx(2)} {...{ ry: 2 }} />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const AlertTriangle = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M12 9v4" />
    <path d="M10.36 3.59 2.26 17.13a1.91 1.91 0 0 0 1.64 2.87h16.21a1.91 1.91 0 0 0 1.64-2.87L13.64 3.59a1.91 1.91 0 0 0-3.28 0z" />
    <path d="M12 16h.01" />
  </svg>
);

export const Folder = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
  </svg>
);

export const FileIcon = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </svg>
);

export const ImageIcon = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <rect height="18" width="18" x="3" y="3" {...rx(2)} {...{ ry: 2 }} />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
  </svg>
);

export const Download = (p: IconProps) => (
  <svg {...base(p, 16)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);
