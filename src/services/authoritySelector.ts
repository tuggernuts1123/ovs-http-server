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
// Two entry points:
//   • selectAuthority — cloud or P2P, and which player hosts.
//   • pickRelayRegion — which cloud region a relay (or a fallback relay, when
//     P2P punching fails) should run in: the one closest to equidistant between
//     the players, by the same minimax.
//
// Latency comes from a LatencySource. The default estimates it from geo-IP
// great-circle distance: a proxy, not a measurement — good enough to catch the
// big wins (clustered players far from a region) and conservative because of
// the margin gate. When geo is unknown for any player (local/reserved IPs,
// missing geoip data), selection falls back to cloud. Measured RTTs (client
// probes, or the RTT the punching handshake observes) plug in as another
// LatencySource without touching the selection logic.

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

export interface LatLon { lat: number; lon: number; }

export interface Region extends LatLon {
  /** Deploy target name, e.g. "us-east-1". */
  id: string;
}

export interface AuthorityDecision {
  /** 0 = cloud/dedicated (unchanged), 1 = Preferred P2P, 2 = Forced P2P. */
  p2pMode: P2PMode;
  /** playerIndex chosen to host the authority, or null when cloud is chosen. */
  hostIndex: number | null;
  /** Best cloud region for this match (where the relay runs if cloud is used or P2P falls back), when known. */
  regionId: string | null;
  /** Human-readable rationale for logs. */
  reason: string;
  /** Estimated worst-player latency (ms) for the chosen authority, for logging. */
  estWorstMs: number;
}

/**
 * Where latency numbers come from. Each returns an RTT in ms, or null when it
 * can't say (selection then treats the match as unknown and stays on cloud).
 */
export interface LatencySource {
  playerToRegion(player: AuthorityPlayer, region: Region): number | null;
  playerToPlayer(a: AuthorityPlayer, b: AuthorityPlayer): number | null;
}

// ── Regions ──────────────────────────────────────────────────────────────

// AWS regions by name, so P2P_CLOUD_REGIONS can list deploy targets by id.
// Coordinates are the region's metro, which is all the estimate needs.
export const KNOWN_REGIONS: Record<string, LatLon> = {
  "us-east-1": { lat: 39.0438, lon: -77.4874 }, // N. Virginia (Ashburn)
  "us-east-2": { lat: 40.0992, lon: -83.1141 }, // Ohio
  "us-west-1": { lat: 37.3382, lon: -121.8863 }, // N. California
  "us-west-2": { lat: 45.8399, lon: -119.7006 }, // Oregon
  "ca-central-1": { lat: 45.5017, lon: -73.5673 }, // Montreal
  "sa-east-1": { lat: -23.5505, lon: -46.6333 }, // São Paulo
  "eu-west-1": { lat: 53.3498, lon: -6.2603 }, // Dublin
  "eu-west-2": { lat: 51.5072, lon: -0.1276 }, // London
  "eu-central-1": { lat: 50.1109, lon: 8.6821 }, // Frankfurt
  "ap-northeast-1": { lat: 35.6762, lon: 139.6503 }, // Tokyo
  "ap-southeast-1": { lat: 1.3521, lon: 103.8198 }, // Singapore
  "ap-southeast-2": { lat: -33.8688, lon: 151.2093 }, // Sydney
};

// Only regions a relay can actually be deployed to belong here: picking one
// without a server would strand the match. The default is us-east-1, the
// "ec2-us-east-1-dokken" cluster OVS runs today. Override with P2P_CLOUD_REGIONS,
// a JSON array of region ids and/or {"id","lat","lon"} objects, e.g.
// '["us-east-1","us-west-2","eu-west-1"]'.
const DEFAULT_REGIONS: Region[] = [{ id: "us-east-1", ...KNOWN_REGIONS["us-east-1"] }];

export function parseCloudRegions(raw: unknown): Region[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out: Region[] = [];
    for (const r of arr) {
      if (typeof r === "string") {
        const known = KNOWN_REGIONS[r];
        if (known) out.push({ id: r, ...known });
        else logger.warn(`${logPrefix} Unknown region "${r}" in P2P_CLOUD_REGIONS; give it as {"id","lat","lon"}.`);
      } else if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
        out.push({ id: typeof r.id === "string" && r.id ? r.id : `region-${out.length + 1}`, lat: r.lat, lon: r.lon });
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function configuredRegions(): Region[] {
  return parseCloudRegions(process.env.P2P_CLOUD_REGIONS) ?? DEFAULT_REGIONS;
}

// ── Config (env-overridable) ─────────────────────────────────────────────
// Read straight from process.env at call time (not the envalid schema) so these
// optional knobs need no schema declaration and always have safe defaults.

interface SelectionConfig {
  /** Master switch. When off, always returns cloud (p2pMode 0) — current behavior. */
  enabled: boolean;
  /** P2P must beat the best cloud region's worst-player latency by at least this many ms. */
  marginMs: number;
  /** Only apply P2P to matches with at most this many human peers (1v1 = 2). */
  maxPeers: number;
}

function selectionConfig(): SelectionConfig {
  return {
    enabled: process.env.P2P_SELECTION_ENABLED === "1",
    marginMs: Number(process.env.P2P_SELECTION_MARGIN_MS ?? 25),
    maxPeers: Number(process.env.P2P_SELECTION_MAX_PEERS ?? 2),
  };
}

// The host pays ~localhost latency to its own authority (engine/loopback stack).
const HOST_SELF_MS = 5;

// ── Geo-IP latency estimate ──────────────────────────────────────────────
// Great-circle km → estimated internet RTT (ms). Real paths inflate over the
// straight-line distance (routing, last-mile), so we use a per-km slope plus a
// fixed base. Only the RELATIVE ordering matters for minimax; the margin gate
// absorbs absolute error. base≈12ms, slope≈0.032 ms/km ≈ 2× fiber lower bound.
const RTT_BASE_MS = 12;
const RTT_PER_KM = 0.032;

export function estimateRttMs(a: LatLon, b: LatLon): number {
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

export const geoLatency: LatencySource = {
  playerToRegion(player, region) {
    const ll = geoForIp(player.ip);
    return ll ? estimateRttMs(ll, region) : null;
  },
  playerToPlayer(a, b) {
    const la = geoForIp(a.ip);
    const lb = geoForIp(b.ip);
    return la && lb ? estimateRttMs(la, lb) : null;
  },
};

// ── Selection ────────────────────────────────────────────────────────────

/**
 * The region a relay for these players should run in: the one that minimises
 * the worst player's latency, i.e. the closest to equidistant between them.
 * Null when there are no players or regions, or latency is unknown for a player.
 */
export function pickRelayRegion(
  players: AuthorityPlayer[],
  regions: Region[] = configuredRegions(),
  latency: LatencySource = geoLatency,
): { region: Region; worstMs: number } | null {
  if (players.length === 0) return null;
  let best: { region: Region; worstMs: number } | null = null;
  for (const region of regions) {
    let worst = 0;
    for (const p of players) {
      const ms = latency.playerToRegion(p, region);
      if (ms === null) return null;
      worst = Math.max(worst, ms);
    }
    if (!best || worst < best.worstMs) best = { region, worstMs: worst };
  }
  return best;
}

/**
 * Decide the authority for a match. `players` are the human, team-side peers
 * (exclude spectators and bots before calling). Returns cloud (p2pMode 0) unless
 * a host peer's worst-player latency beats the best cloud region by the margin.
 */
export function selectAuthority(
  players: AuthorityPlayer[],
  latency: LatencySource = geoLatency,
  regions: Region[] = configuredRegions(),
): AuthorityDecision {
  const config = selectionConfig();
  const relay = pickRelayRegion(players, regions, latency);
  const cloud: AuthorityDecision = {
    p2pMode: 0,
    hostIndex: null,
    regionId: relay?.region.id ?? null,
    reason: "cloud (default)",
    estWorstMs: relay ? Math.round(relay.worstMs) : 0,
  };

  if (!config.enabled) return { ...cloud, reason: "cloud (selection disabled)" };
  if (players.length < 2) return { ...cloud, reason: "cloud (<2 peers)" };
  if (players.length > config.maxPeers) {
    return { ...cloud, reason: `cloud (>${config.maxPeers} peers)` };
  }
  // Need latency for every player, else we can't compare fairly → cloud.
  if (!relay) return { ...cloud, reason: "cloud (latency unknown for a player)" };

  // Best P2P host: minimise the worst GUEST's RTT to that host (host pays ~0).
  let bestHostIndex: number | null = null;
  let bestHostWorst = Infinity;
  for (const host of players) {
    let worst = HOST_SELF_MS;
    for (const guest of players) {
      if (guest.playerIndex === host.playerIndex) continue;
      const ms = latency.playerToPlayer(guest, host);
      if (ms === null) return { ...cloud, reason: "cloud (latency unknown for a player)" };
      worst = Math.max(worst, ms);
    }
    if (worst < bestHostWorst) {
      bestHostWorst = worst;
      bestHostIndex = host.playerIndex;
    }
  }

  const cloudWorst = relay.worstMs;
  if (bestHostIndex !== null && bestHostWorst + config.marginMs < cloudWorst) {
    return {
      ...cloud,
      p2pMode: 1, // Preferred: server relay remains a fallback if punching fails
      hostIndex: bestHostIndex,
      reason: `p2p host=${bestHostIndex} (worst≈${Math.round(bestHostWorst)}ms vs cloud ${relay.region.id}≈${Math.round(cloudWorst)}ms)`,
      estWorstMs: Math.round(bestHostWorst),
    };
  }

  return {
    ...cloud,
    reason: `cloud ${relay.region.id} (best≈${Math.round(cloudWorst)}ms; p2p host≈${Math.round(bestHostWorst)}ms not > margin)`,
  };
}
