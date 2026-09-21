"use client";

/**
 * Animated scenic backdrop — inspired by a journey illustration:
 * traveler with hat & backpack walking through tall grass near water,
 * mountains with clouds and birds in the background.
 * Pure SVG + CSS: no image assets, fully responsive.
 */
export function LockScene() {
  return (
    <div className="scene" aria-hidden>
      {/* sky gradient */}
      <div className="sky" />

      {/* sun glow */}
      <div className="sun" />

      {/* clouds — slow drift */}
      <svg className="clouds" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMid slice">
        <g fill="rgba(255,255,255,0.85)">
          <g className="cloud c1">
            <ellipse cx="180" cy="80" rx="70" ry="24" />
            <ellipse cx="230" cy="65" rx="55" ry="28" />
            <ellipse cx="130" cy="70" rx="45" ry="20" />
          </g>
          <g className="cloud c2" opacity="0.75">
            <ellipse cx="640" cy="120" rx="90" ry="26" />
            <ellipse cx="700" cy="100" rx="60" ry="30" />
          </g>
          <g className="cloud c3" opacity="0.6">
            <ellipse cx="980" cy="60" rx="75" ry="22" />
            <ellipse cx="1030" cy="48" rx="45" ry="24" />
          </g>
        </g>
      </svg>

      {/* birds — drifting across */}
      <svg className="birds" viewBox="0 0 600 200" preserveAspectRatio="xMidYMid meet">
        <g stroke="rgba(20,30,50,0.65)" strokeWidth="3" fill="none" strokeLinecap="round">
          <path className="bird b1" d="M40 60 Q52 48 64 60 Q76 48 88 60" />
          <path className="bird b2" d="M120 100 Q130 90 140 100 Q150 90 160 100" />
          <path className="bird b3" d="M90 140 Q98 132 106 140 Q114 132 122 140" />
        </g>
      </svg>

      {/* mountain layers */}
      <svg className="mountains" viewBox="0 0 1200 420" preserveAspectRatio="xMidYMax slice">
        <path fill="#5b74a8" d="M0 420 L0 260 L180 90 L320 240 L470 60 L640 250 L760 140 L920 300 L1080 170 L1200 280 L1200 420 Z" />
        <path fill="#43598c" d="M0 420 L0 320 L220 180 L400 320 L560 160 L760 330 L940 220 L1200 340 L1200 420 Z" opacity="0.9" />
        {/* snow caps */}
        <path fill="#e9eefb" d="M470 60 L510 110 L488 104 L470 122 L452 100 L432 108 Z" />
        <path fill="#e9eefb" d="M180 90 L212 132 L194 126 L180 142 L164 122 L150 130 Z" opacity="0.9" />
      </svg>

      {/* water with shimmer */}
      <div className="water">
        <div className="shimmer s1" />
        <div className="shimmer s2" />
        <div className="shimmer s3" />
      </div>

      {/* grass foreground */}
      <svg className="grass" viewBox="0 0 1200 260" preserveAspectRatio="xMidYMax slice">
        <g fill="none" stroke="#1d3a2f" strokeWidth="7" strokeLinecap="round">
          {Array.from({ length: 26 }).map((_, i) => {
            const x = i * 48 + (i % 3) * 7;
            const h = 90 + ((i * 37) % 80);
            const bend = (i % 2 === 0 ? 1 : -1) * (10 + ((i * 13) % 22));
            return (
              <path key={i} className="blade" style={{ animationDelay: `${(i % 7) * 0.35}s` }}
                d={`M${x} 260 Q${x + bend} ${260 - h * 0.6} ${x + bend * 2} ${260 - h}`} />
            );
          })}
        </g>
        <g fill="none" stroke="#27503e" strokeWidth="5" strokeLinecap="round">
          {Array.from({ length: 18 }).map((_, i) => {
            const x = 24 + i * 66;
            const h = 60 + ((i * 53) % 60);
            const bend = (i % 2 === 0 ? -1 : 1) * (12 + ((i * 17) % 18));
            return (
              <path key={i} className="blade" style={{ animationDelay: `${(i % 5) * 0.4}s` }}
                d={`M${x} 260 Q${x + bend} ${260 - h * 0.6} ${x + bend * 2} ${260 - h}`} />
            );
          })}
        </g>
      </svg>

      {/* traveler with hat & backpack */}
      <svg className="traveler" viewBox="0 0 120 200" preserveAspectRatio="xMidYMax meet">
        {/* backpack */}
        <rect x="30" y="86" width="22" height="34" rx="9" fill="#8a5a33" />
        <rect x="34" y="96" width="14" height="4" rx="2" fill="#5f3d21" />
        {/* body */}
        <path d="M52 92 Q60 86 68 92 L72 132 Q60 138 48 132 Z" fill="#b3542e" />
        {/* legs — walking */}
        <path className="leg leg-a" d="M56 132 L50 168 L46 188" stroke="#3d2c1e" strokeWidth="9" fill="none" strokeLinecap="round" />
        <path className="leg leg-b" d="M66 132 L72 166 L78 186" stroke="#4a3826" strokeWidth="9" fill="none" strokeLinecap="round" />
        {/* arms */}
        <path className="arm" d="M52 98 L42 116" stroke="#b3542e" strokeWidth="8" fill="none" strokeLinecap="round" />
        <path className="arm arm-b" d="M68 98 L78 112" stroke="#a04a28" strokeWidth="8" fill="none" strokeLinecap="round" />
        {/* head */}
        <circle cx="60" cy="70" r="14" fill="#e8b98c" />
        {/* hat */}
        <ellipse cx="60" cy="60" rx="26" ry="6" fill="#6b4a2b" />
        <path d="M48 60 Q60 42 72 60 Z" fill="#7d5733" />
      </svg>
    </div>
  );
}
