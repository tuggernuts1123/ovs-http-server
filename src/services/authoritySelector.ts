// authoritySelector.ts
//
// Per-match authority selection for the OVS rollback stack.
//
// The rollback netcode can run in two topologies:
//   • Dedicated (cloud): every player's input relays through a cloud rollback
//     server. Symmetric — each player pays their RTT to the region. This is the
//     classic, fair, stable default.
//   • Host-authoritative P2P: one player ("host") runs the authority and the
//     others open direct UDP holes to it. One hop instead of two; big win when
//     the players are near each other but far from any region — but the host
//     gets a ~0-latency advantage and it only helps if the direct path is
//     genuinely shorter.
//
// Rather than a global P2P on/off, this module chooses PER MATCH whichever
// authority minimises the WORST player's latency (a minimax), and only picks
// P2P when it beats the best cloud region by a real margin (so we don't take on
// the host-advantage / NAT-traversal downside for a marginal gain).
//
// Latency is estimated from geo-IP great-circle distance. That's a proxy, not a
// measurement — good enough to catch the big wins (clustered players far from a
// region) and conservative because of the margin gate. When geo is unknown for
// any player (local/reserved IPs, missing geoip data), we fall back to cloud.
// The scoring is isolated here so a future measured-RTT source (client probes)
// can replace estimateRttMs without touching callers.

import { logger } from "../config/logger";

const logPrefix = "[Services.AuthoritySelector]:";

// geoip-lite is an offline dependency (bundled MaxMind GeoLite data). Loaded
// lazily and guarded so the server still boots (and simply never picks P2P) if
// the package or its data isn't present.
let geoip: { lookup: (ip: string) => { ll?: [number, number] } | null } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  geoip = require("geoip-lite");
} catch {
  logger.warn(`${logPrefix} geoip-lite not available; P2P authority selection will stay on cloud.`);
}

export type P2PMode = 0 | 1 | 2; // Off | Preferred | Forced

export interface AuthorityPlayer {
  playerIndex: number;
  ip: string;
}

export interface AuthorityDecision {
  /** 0 = cloud/dedicated (unchanged), 1 = Preferred P2P, 2 = Forced P2P. */
  p2pMode: P2PMode;
  /** playerIndex chosen to host the authority, or null when cloud is chosen. */
  hostIndex: number | null;
  /** Human-readable rationale for logs. */
  reason: string;
  /** Estimated worst-player latency (ms) for the chosen authority, for logging. */
  estWorstMs: number;
}

interface LatLon { lat: number; lon: number; }

// ── Config (env-overridable) ─────────────────────────────────────────────
// Read straight from process.env (not the envalid schema) so these optional
// knobs need no schema declaration and always have safe defaults.
// Master switch. When off, always returns cloud (p2pMode 0) — current behavior.
const P2P_SELECTION_ENABLED = process.env.P2P_SELECTION_ENABLED === "1";

// P2P must beat the best cloud region's worst-player latency by at least this
// many ms to be chosen. Guards against flipping to P2P for marginal gains.
const P2P_MARGIN_MS = Number(process.env.P2P_SELECTION_MARGIN_MS ?? 25);

// Only apply P2P to matches with at most this many human peers (1v1 = 2).
// Host-authority fairness/complexity grows past 1v1; widen deliberately later.
const P2P_MAX_PEERS = Number(process.env.P2P_SELECTION_MAX_PEERS ?? 2);

// Cloud rollback regions (lat/lon). Cost of a cloud authority = the worst
// player's estimated RTT to the nearest of these. Defaults to AWS us-east-1
// (Ashburn, VA) — the "ec2-us-east-1-dokken" cluster OVS already uses. Override
// with P2P_CLOUD_REGIONS='[{"lat":..,"lon":..},...]'.
const CLOUD_REGIONS: LatLon[] = parseCloudRegions(process.env.P2P_CLOUD_REGIONS) ?? [
  { lat: 39.0438, lon: -77.4874 }, // AWS us-east-1, Ashburn VA
];

// The host pays ~localhost latency to its own authority (engine/loopback stack).
const HOST_SELF_MS = 5;

// ── RTT model ────────────────────────────────────────────────────────────
// Great-circle km → estimated internet RTT (ms). Real paths inflate over the
// straight-line distance (routing, last-mile), so we use a per-km slope plus a
// fixed base. Only the RELATIVE ordering matters for minimax; the margin gate
// absorbs absolute error. base≈12ms, slope≈0.032 ms/km ≈ 2× fiber lower bound.
const RTT_BASE_MS = 12;
const RTT_PER_KM = 0.032;

function estimateRttMs(a: LatLon, b: LatLon): number {
  return RTT_BASE_MS + haversineKm(a, b) * RTT_PER_KM;
}

function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const dLat = deg2rad(b.lat - a.lat);
  const dLon = deg2rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

function geoForIp(ip: string): LatLon | null {
  if (!geoip || !ip) return null;
  try {
    const g = geoip.lookup(ip);
    if (g && Array.isArray(g.ll) && g.ll.length === 2) {
      const [lat, lon] = g.ll;
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

// ── Selection ────────────────────────────────────────────────────────────

/**
 * Decide the authority for a match. `players` are the human, team-side peers
 * (exclude spectators and bots before calling). Returns cloud (p2pMode 0) unless
 * a host peer's worst-player latency beats the best cloud region by the margin.
 */
export function selectAuthority(players: AuthorityPlayer[]): AuthorityDecision {
  const cloud: AuthorityDecision = {
    p2pMode: 0,
    hostIndex: null,
    reason: "cloud (default)",
    estWorstMs: 0,
  };

  if (!P2P_SELECTION_ENABLED) return { ...cloud, reason: "cloud (selection disabled)" };
  if (players.length < 2) return { ...cloud, reason: "cloud (<2 peers)" };
  if (players.length > P2P_MAX_PEERS) {
    return { ...cloud, reason: `cloud (>${P2P_MAX_PEERS} peers)` };
  }

  // Need geo for every player, else we can't compare fairly → cloud.
  const geo = players.map((p) => ({ p, ll: geoForIp(p.ip) }));
  if (geo.some((g) => g.ll === null)) {
    return { ...cloud, reason: "cloud (geo unknown for a player)" };
  }

  // Best cloud region: minimise the worst player's RTT to a region.
  let cloudWorst = Infinity;
  for (const region of CLOUD_REGIONS) {
    let worst = 0;
    for (const g of geo) worst = Math.max(worst, estimateRttMs(g.ll!, region));
    cloudWorst = Math.min(cloudWorst, worst);
  }

  // Best P2P host: minimise the worst GUEST's RTT to that host (host pays ~0).
  let bestHostIndex: number | null = null;
  let bestHostWorst = Infinity;
  for (const host of geo) {
    let worst = HOST_SELF_MS;
    for (const g of geo) {
      if (g.p.playerIndex === host.p.playerIndex) continue;
      worst = Math.max(worst, estimateRttMs(g.ll!, host.ll!));
    }
    if (worst < bestHostWorst) {
      bestHostWorst = worst;
      bestHostIndex = host.p.playerIndex;
    }
  }

  if (bestHostIndex !== null && bestHostWorst + P2P_MARGIN_MS < cloudWorst) {
    return {
      p2pMode: 1, // Preferred: server relay remains a fallback if punching fails
      hostIndex: bestHostIndex,
      reason: `p2p host=${bestHostIndex} (worst≈${Math.round(bestHostWorst)}ms vs cloud≈${Math.round(cloudWorst)}ms)`,
      estWorstMs: Math.round(bestHostWorst),
    };
  }

  return {
    ...cloud,
    reason: `cloud (best≈${Math.round(cloudWorst)}ms; p2p host≈${Math.round(bestHostWorst)}ms not > margin)`,
    estWorstMs: Math.round(cloudWorst),
  };
}

function parseCloudRegions(raw: unknown): LatLon[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out: LatLon[] = [];
    for (const r of arr) {
      if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
        out.push({ lat: r.lat, lon: r.lon });
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
