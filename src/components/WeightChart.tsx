// 体重の推移を表示する軽量な折れ線グラフ。
// 外部ライブラリに依存せず、サーバーで SVG を直接描画する（クライアント JS 不要）。

export type WeightPoint = {
  date: string; // YYYY-MM-DD
  weight: number; // kg
};

// SVG 座標系（viewBox）。レスポンシブは viewBox + width:100% で対応。
const W = 320;
const H = 160;
const PAD_X = 36;
const PAD_Y = 18;

function formatShortDate(d: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(d));
}

export default function WeightChart({ points }: { points: WeightPoint[] }) {
  if (points.length === 0) return null;

  const weights = points.map((p) => p.weight);
  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);
  // 上下に少し余白を持たせる（全点同値でもつぶれないよう最低 0.2kg 確保）
  const span = Math.max(maxW - minW, 0.2);
  const yMin = minW - span * 0.2;
  const yMax = maxW + span * 0.2;

  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;

  const x = (i: number) =>
    points.length === 1
      ? PAD_X + innerW / 2
      : PAD_X + (innerW * i) / (points.length - 1);
  const y = (w: number) =>
    PAD_Y + innerH * (1 - (w - yMin) / (yMax - yMin));

  const coords = points.map((p, i) => ({ cx: x(i), cy: y(p.weight), ...p }));
  const linePath = coords.map((c) => `${c.cx},${c.cy}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="体重の推移グラフ"
    >
      {/* y 軸の目盛り（最小 / 最大） */}
      {[yMax, yMin].map((v, idx) => {
        const gy = y(v);
        return (
          <g key={idx}>
            <line
              x1={PAD_X}
              x2={W - PAD_X}
              y1={gy}
              y2={gy}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <text
              x={PAD_X - 6}
              y={gy + 3}
              textAnchor="end"
              className="fill-slate-400"
              fontSize={9}
            >
              {v.toFixed(2)}
            </text>
          </g>
        );
      })}

      {/* 折れ線（2点以上のとき） */}
      {coords.length > 1 && (
        <polyline
          points={linePath}
          fill="none"
          stroke="#0284c7"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* 各データ点 */}
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.cx} cy={c.cy} r={3} fill="#0284c7" />
          {/* 端の日付ラベル（最初と最後のみ表示して混雑を避ける） */}
          {(i === 0 || i === coords.length - 1) && (
            <text
              x={c.cx}
              y={H - 4}
              textAnchor={i === 0 ? "start" : "end"}
              className="fill-slate-400"
              fontSize={9}
            >
              {formatShortDate(c.date)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
