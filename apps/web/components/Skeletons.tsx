"use client";

/** Shimmering skeleton loaders — perceived-performance polish. */
export function SkeletonTile({ h = 84 }: { h?: number }) {
  return <div className="skel" style={{ height: h }} />;
}

export function SkeletonTiles({ n = 4 }: { n?: number }) {
  return (
    <div className="tile-grid">
      {Array.from({ length: n }).map((_, i) => <SkeletonTile key={i} />)}
    </div>
  );
}

export function SkeletonCard({ h = 120 }: { h?: number }) {
  return <div className="skel" style={{ height: h, marginBottom: 14 }} />;
}
