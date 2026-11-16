"use client";

import { useMemo, useState } from "react";

/**
 * SSIS insight charts: pure SVG in the same style as the dashboard's
 * NetWorthChart (no chart library). Values arrive pre-computed from the
 * domain layer; these components only handle geometry and hover.
 */

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 22, left: 12 };

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`)
  );
}

export type SsisLineSeries = {
  label: string;
  color: string;
  values: (number | null)[];
  format: (value: number) => string;
};

export function SsisLineChart({ dates, series }: { dates: string[]; series: SsisLineSeries[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => {
    if (dates.length < 2 || series.length === 0) return null;
    const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    if (all.length < 2) return null;
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;
    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const stepX = innerW / (dates.length - 1);
    const x = (i: number) => PAD.left + i * stepX;
    const y = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH;
    const lines = series.map((s) => {
      const pts: string[] = [];
      s.values.forEach((v, i) => {
        if (v !== null) pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      });
      return pts.join(" ");
    });
    return { x, y, lines, min, max };
  }, [dates, series]);

  if (!geometry) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Not enough data to chart yet.
      </div>
    );
  }

  const hover = hoverIndex !== null ? Math.min(hoverIndex, dates.length - 1) : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const idx = Math.round(ratio * (dates.length - 1));
          setHoverIndex(Math.max(0, Math.min(dates.length - 1, idx)));
        }}
      >
        {series.map((s, si) => (
          <polyline
            key={s.label}
            points={geometry.lines[si]}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null ? (
          <line
            x1={geometry.x(hover)}
            x2={geometry.x(hover)}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
            stroke="currentColor"
            strokeOpacity="0.2"
          />
        ) : null}
        {hover !== null
          ? series.map((s) => {
              const v = s.values[hover];
              return v === null || v === undefined ? null : (
                <circle
                  key={s.label}
                  cx={geometry.x(hover)}
                  cy={geometry.y(v)}
                  r="3.5"
                  fill={s.color}
                />
              );
            })
          : null}
        <text x={PAD.left} y={HEIGHT - 6} fontSize="11" className="fill-muted-foreground">
          {formatDay(dates[0]!)}
        </text>
        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 6}
          fontSize="11"
          textAnchor="end"
          className="fill-muted-foreground"
        >
          {formatDay(dates[dates.length - 1]!)}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
            {hover !== null && s.values[hover] !== null ? `: ${s.format(s.values[hover]!)}` : ""}
          </span>
        ))}
        {hover !== null ? <span>{formatDay(dates[hover]!)}</span> : null}
      </div>
    </div>
  );
}

/**
 * Purchase history combo: bars are units purchased (scaled to the units
 * range), the line is the purchase NAV (scaled to its own range) — the two
 * scales are independent, like the standalone dashboard's chart.
 */
export function SsisPurchaseChart({
  dates,
  units,
  navs
}: {
  dates: string[];
  units: number[];
  navs: (number | null)[];
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => {
    if (dates.length === 0) return null;
    const maxUnits = Math.max(...units, 0);
    const navValues = navs.filter((v): v is number => v !== null);
    const minNav = navValues.length ? Math.min(...navValues) : 0;
    const maxNav = navValues.length ? Math.max(...navValues) : 1;
    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const stepX = dates.length > 1 ? innerW / dates.length : innerW;
    const barW = Math.max(2, Math.min(18, stepX * 0.6));
    const navSpan = maxNav - minNav || 1;
    const bars = units.map((u, i) => {
      const h = maxUnits > 0 ? (u / maxUnits) * innerH : 0;
      return {
        x: PAD.left + i * stepX + (stepX - barW) / 2,
        y: PAD.top + innerH - h,
        w: barW,
        h
      };
    });
    const linePts: string[] = [];
    navs.forEach((v, i) => {
      if (v === null) return;
      const cx = PAD.left + i * stepX + stepX / 2;
      const cy = PAD.top + innerH - ((v - minNav) / navSpan) * innerH;
      linePts.push(`${cx.toFixed(1)},${cy.toFixed(1)}`);
    });
    return { bars, line: linePts.join(" "), stepX };
  }, [dates, units, navs]);

  if (!geometry || dates.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Not enough data to chart yet.
      </div>
    );
  }
  const hover = hoverIndex !== null ? Math.min(hoverIndex, dates.length - 1) : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          setHoverIndex(Math.max(0, Math.min(dates.length - 1, Math.floor(ratio * dates.length))));
        }}
      >
        {geometry.bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={bar.y}
            width={bar.w}
            height={bar.h}
            rx="1.5"
            fill="#2563eb"
            fillOpacity={hover === i ? 0.95 : 0.65}
          />
        ))}
        {geometry.line ? (
          <polyline
            points={geometry.line}
            fill="none"
            stroke="#d97706"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        <text x={PAD.left} y={HEIGHT - 6} fontSize="11" className="fill-muted-foreground">
          {formatDay(dates[0]!)}
        </text>
        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 6}
          fontSize="11"
          textAnchor="end"
          className="fill-muted-foreground"
        >
          {formatDay(dates[dates.length - 1]!)}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#2563eb]" />
          Units{hover !== null ? `: ${units[hover]!.toLocaleString("en")}` : ""}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#d97706]" />
          Purchase NAV
          {hover !== null && navs[hover] !== null ? `: ${navs[hover]!.toFixed(2)}` : ""}
        </span>
        {hover !== null ? <span>{formatDay(dates[hover]!)}</span> : null}
      </div>
    </div>
  );
}
