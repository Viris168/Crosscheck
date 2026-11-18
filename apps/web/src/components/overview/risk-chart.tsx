import type { OverviewResponse } from '@app/shared/client';
import type { z } from 'zod';

type Point = z.infer<typeof OverviewResponse>['riskOverTime'][number];

const W = 720;
const H = 180;
const PAD = { l: 32, r: 8, t: 8, b: 22 };

/** Average risk score per day (0–100) as bars; days without completed reviews are empty. */
export function RiskChart({ points }: { points: Point[] }) {
  const scored = points.filter((p) => p.avgRiskScore != null);
  if (scored.length === 0) {
    return <p className="text-sm text-muted-foreground">No completed reviews in this range.</p>;
  }
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const step = innerW / points.length;
  const barW = Math.max(1, step * 0.7);
  const y = (v: number) => PAD.t + innerH - (v / 100) * innerH;
  const first = points[0]?.date;
  const last = points[points.length - 1]?.date;

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Average risk score per day from ${first} to ${last}`}
      >
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="stroke-border" />
            <text
              x={PAD.l - 6}
              y={y(v) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {v}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          p.avgRiskScore == null ? null : (
            <rect
              key={p.date}
              x={PAD.l + i * step + (step - barW) / 2}
              y={y(p.avgRiskScore)}
              width={barW}
              height={PAD.t + innerH - y(p.avgRiskScore)}
              rx={1}
              className="fill-blue-500"
            >
              <title>
                {p.date}: avg risk {p.avgRiskScore} ({p.reviews} reviews)
              </title>
            </rect>
          ),
        )}
        <text x={PAD.l} y={H - 4} className="fill-muted-foreground text-[10px]">
          {first}
        </text>
        <text
          x={W - PAD.r}
          y={H - 4}
          textAnchor="end"
          className="fill-muted-foreground text-[10px]"
        >
          {last}
        </text>
      </svg>
      <figcaption className="sr-only">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Reviews</th>
              <th>Average risk</th>
            </tr>
          </thead>
          <tbody>
            {scored.map((p) => (
              <tr key={p.date}>
                <td>{p.date}</td>
                <td>{p.reviews}</td>
                <td>{p.avgRiskScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
