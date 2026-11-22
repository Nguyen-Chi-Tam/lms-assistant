'use client';

interface PlayableArtworkProps {
  id: string;
  className?: string;
}

interface TileGridProps {
  cols: number;
  rows: number;
  filled: number[];
  cell?: number;
  gap?: number;
}

/** Small rounded-grid motif reused by the crossword and bingo artworks. */
function TileGrid({ cols, rows, filled, cell = 22, gap = 5 }: TileGridProps) {
  const width = cols * cell + (cols - 1) * gap;
  const height = rows * cell + (rows - 1) * gap;
  const x0 = (120 - width) / 2;
  const y0 = (120 - height) / 2;

  return (
    <>
      {Array.from({ length: cols * rows }, (_, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const isFilled = filled.includes(index);
        return (
          <rect
            key={index}
            x={x0 + col * (cell + gap)}
            y={y0 + row * (cell + gap)}
            width={cell}
            height={cell}
            rx={5}
            fill={isFilled ? 'currentColor' : 'none'}
            fillOpacity={isFilled ? 0.22 : 0}
          />
        );
      })}
    </>
  );
}

/**
 * Decorative line-art for each playable tile. Pure inline SVG so it inherits the
 * card accent colour and stays crisp at any size (no image assets needed).
 */
export function PlayableArtwork({ id, className }: PlayableArtworkProps) {
  let art: React.ReactNode;

  switch (id) {
    case 'quiz':
      art = (
        <>
          <rect x="22" y="32" width="52" height="64" rx="10" opacity=".45" />
          <rect x="34" y="22" width="52" height="64" rx="10" />
          <path d="M46 44h28M46 56h20" />
          <circle cx="86" cy="82" r="17" />
          <path d="M78 82l6 6 10-12" />
        </>
      );
      break;

    case 'mystery':
      art = (
        <>
          <circle cx="60" cy="58" r="38" strokeDasharray="4 8" opacity=".7" />
          <circle cx="60" cy="58" r="23" opacity=".4" />
          <path d="M50 47c0-7 5-11 11-11s11 4 11 10c0 6-6 7-9 12" />
          <circle cx="62" cy="74" r="2.6" fill="currentColor" stroke="none" />
        </>
      );
      break;

    case 'speed':
      art = (
        <>
          <rect x="14" y="24" width="34" height="22" rx="7" />
          <rect x="72" y="24" width="34" height="22" rx="7" opacity=".5" />
          <rect x="14" y="74" width="34" height="22" rx="7" opacity=".5" />
          <rect x="72" y="74" width="34" height="22" rx="7" />
          <path d="M52 35h16M52 85h16" strokeDasharray="3 5" opacity=".7" />
          <path d="M36 60c10 0 10-12 20-12M84 60c-10 0-10 12-20 12" strokeDasharray="2 6" opacity=".45" />
        </>
      );
      break;

    case 'bug':
      art = (
        <>
          <rect x="14" y="26" width="92" height="68" rx="10" />
          <path d="M28 44h18M28 58h30M28 72h14" />
          <circle cx="78" cy="72" r="14" />
          <path d="M88 82l11 11M71 72h14" />
        </>
      );
      break;

    case 'swipe':
      art = (
        <>
          <rect x="16" y="34" width="52" height="52" rx="10" transform="rotate(-8 42 60)" opacity=".5" />
          <rect x="52" y="34" width="52" height="52" rx="10" transform="rotate(8 78 60)" />
          <path d="M66 60H54M59 55l-6 5 6 5" />
          <path d="M83 47l4 4 7-8" opacity=".65" />
        </>
      );
      break;

    case 'crossword': {
      // A recognisable crossword silhouette: a vertical spine crossed by two
      // horizontal answers, rather than a generic square grid.
      const cell = 18;
      const gap = 2;
      const cols = 5;
      const rows = 5;
      const width = cols * cell + (cols - 1) * gap;
      const height = rows * cell + (rows - 1) * gap;
      const x0 = (120 - width) / 2;
      const y0 = (120 - height) / 2;

      const activeCells = new Set([
        2, // top of the vertical answer
        6, 7, 8, 9, // upper horizontal answer
        12, // centre intersection
        15, 16, 17, 18, // lower horizontal answer
        22, // bottom of the vertical answer
      ]);
      // Keep the motif inside the parent SVG. Returning the fragment here would
      // render its SVG primitives as regular HTML elements, which makes the
      // letters fall out of the grid on the learning-space card.
      art = (
        <>
          {Array.from({ length: cols * rows }, (_, index) => {
            const ci = index % cols;
            const ri = Math.floor(index / cols);
            if (!activeCells.has(index)) return null;

              const x = x0 + ci * (cell + gap);
              const y = y0 + ri * (cell + gap);
              return (
                <g key={index}>
                  <rect
                    x={x}
                    y={y}
                    width={cell}
                    height={cell}
                    rx={2.5}
                    fill="currentColor"
                    fillOpacity=".08"
                    stroke="currentColor"
                    strokeWidth="2.2"
                  />
                </g>
              );
            })}
        </>
      );
      break;
    }

    case 'bingo':
      art = <TileGrid cols={4} rows={3} filled={[1, 6, 9]} cell={24} />;
      break;

    default:
      art = (
        <>
          <circle cx="60" cy="60" r="30" strokeDasharray="5 8" />
          <path d="M60 40v40M40 60h40" />
        </>
      );
  }

  return (
    <svg
      className={className}
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {art}
    </svg>
  );
}
