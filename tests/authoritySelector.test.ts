import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorityPlayer,
  KNOWN_REGIONS,
  LatencySource,
  LatLon,
  Region,
  estimateRttMs,
  parseCloudRegions,
  pickRelayRegion,
  selectAuthority,
} from "../src/services/authoritySelector";

// Players placed at fixed coordinates (keyed by their "ip"), latency from the
// same distance estimate the geo-IP source uses, so no geoip data is needed.
const PLACES: Record<string, LatLon> = {
  seattle: { lat: 47.6062, lon: -122.3321 },
  portland: { lat: 45.5152, lon: -122.6784 },
  boston: { lat: 42.3601, lon: -71.0589 },
  london: { lat: 51.5072, lon: -0.1276 },
};
const placed: LatencySource = {
  playerToRegion: (p, r) => (PLACES[p.ip] ? estimateRttMs(PLACES[p.ip], r) : null),
  playerToPlayer: (a, b) => (PLACES[a.ip] && PLACES[b.ip] ? estimateRttMs(PLACES[a.ip], PLACES[b.ip]) : null),
};
const players = (...ips: string[]): AuthorityPlayer[] => ips.map((ip, playerIndex) => ({ playerIndex, ip }));
const region = (id: string): Region => ({ id, ...KNOWN_REGIONS[id] });
const US = [region("us-east-1"), region("us-west-2")];

function withSelection<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("the relay region is the one nearest equidistant between the players", () => {
  assert.equal(pickRelayRegion(players("seattle", "portland"), US, placed)?.region.id, "us-west-2");
  assert.equal(pickRelayRegion(players("boston", "boston"), US, placed)?.region.id, "us-east-1");
  // Seattle + London: Virginia is the better compromise than Oregon.
  assert.equal(pickRelayRegion(players("seattle", "london"), US, placed)?.region.id, "us-east-1");
});

test("no relay region when a player's latency is unknown", () => {
  assert.equal(pickRelayRegion(players("seattle", "nowhere"), US, placed), null);
  assert.equal(pickRelayRegion([], US, placed), null);
});

test("selection is off unless P2P_SELECTION_ENABLED=1, but still reports the region", () => {
  const d = withSelection({ P2P_SELECTION_ENABLED: undefined }, () => selectAuthority(players("seattle", "portland"), placed, US));
  assert.equal(d.p2pMode, 0);
  assert.equal(d.regionId, "us-west-2");
});

test("P2P only when a host beats the best region by the margin", () => {
  withSelection({ P2P_SELECTION_ENABLED: "1", P2P_SELECTION_MARGIN_MS: "25" }, () => {
    // Two Pacific Northwest players, only a Virginia region: host P2P wins big.
    const far = selectAuthority(players("seattle", "portland"), placed, [region("us-east-1")]);
    assert.equal(far.p2pMode, 1);
    assert.notEqual(far.hostIndex, null);
    assert.equal(far.regionId, "us-east-1");
    // With Oregon available the region is close enough: stay on cloud there.
    const near = selectAuthority(players("seattle", "portland"), placed, US);
    assert.equal(near.p2pMode, 0);
    assert.equal(near.regionId, "us-west-2");
  });
});

test("unknown latency or too many peers stays on cloud", () => {
  withSelection({ P2P_SELECTION_ENABLED: "1", P2P_SELECTION_MAX_PEERS: "2" }, () => {
    assert.equal(selectAuthority(players("seattle", "nowhere"), placed, US).p2pMode, 0);
    assert.equal(selectAuthority(players("seattle", "portland", "boston"), placed, US).p2pMode, 0);
  });
});

test("P2P_CLOUD_REGIONS takes region ids and explicit coordinates", () => {
  const parsed = parseCloudRegions('["us-west-2", {"id":"home","lat":1,"lon":2}, "nope"]');
  assert.deepEqual(parsed?.map((r) => r.id), ["us-west-2", "home"]);
  assert.equal(parseCloudRegions(""), null);
  assert.equal(parseCloudRegions("not json"), null);
});
