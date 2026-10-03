import { logger } from "../config/logger";
import {
  redisClient,
  redisGetMatchConfig,
  redisUpdatePlayerStatus,
  redisPushDLLNotification,
} from "../config/redis";
import { processSetResult } from "./eloService";

const logPrefix = "[P2PForfeit]:";

/**
 * Resolve a P2P match forfeit: penalize `leaverId` and award the opposing team.
 *
 * Used by two callers:
 *  - the `/api/ovs_p2p_peer_dropped` endpoint (PRIMARY) — the cloud coordinator
 *    saw this peer stop sending keepalives mid-match while another peer was still
 *    alive, so it is authoritatively the leaver;
 *  - the WebSocket-close path (BACKUP) — after its own crash guards.
 *
 * Idempotent and guarded: no-ops if the game already produced a real result, the
 * match was flagged a crash, or ELO was already processed for this set. Records
 * `p2p_first_dropped:<matchId>` so the WS path can tell victim from leaver.
 *
 * @returns true if a forfeit was actually processed.
 */
export async function processP2PForfeit(matchId: string, leaverId: string, reason: string): Promise<boolean> {
  // A real game result or a flagged crash means this is not a forfeit.
  if (await redisClient.get(`game_result_received:${matchId}`)) return false;
  if (await redisClient.get(`match_server_crash:${matchId}`)) return false;

  const matchConfig = await redisGetMatchConfig(matchId).catch(() => null);
  if (!matchConfig || matchConfig.isCustomGame || (matchConfig.p2pMode ?? 0) <= 0) return false;
  if (!(await redisClient.get(`match_started:${matchId}`))) return false;

  const leaver = matchConfig.players.find((p) => p.playerId === leaverId);
  if (!leaver || leaver.isSpectator || leaver.isBot) return false;

  const hasOpponent = matchConfig.players.some(
    (p) => !p.isSpectator && !p.isBot && p.teamIndex !== leaver.teamIndex,
  );
  if (!hasOpponent) return false;

  // Record the authoritative leaver so the WS-close path defers to it and never
  // penalizes the still-alive victim.
  await redisClient.set(`p2p_first_dropped:${matchId}`, leaverId, { NX: true, EX: 600 });

  // Dedup ELO (shared key with the other dodge/result paths).
  const setId = (await redisClient.get(`player_ranked_set:${leaverId}`)) || matchId;
  const canProcess = await redisClient.set(`elo_processed_set:${setId}`, "p2p_forfeit", { NX: true, EX: 300 });
  if (canProcess !== "OK") return false;
  await redisClient.set(`elo_processed:${matchId}`, "1", { NX: true, EX: 300 });
  // The forfeit is this match's result. Recorded for as long as the match config
  // lives (20 min), so the winner's later disconnect, from the config still on
  // their socket, isn't taken for a pregame dodge.
  await redisClient.set(`game_result_received:${matchId}`, "1", { EX: 60 * 20 });

  const winnerTeam = leaver.teamIndex === 0 ? 1 : 0;
  const team0Ids = matchConfig.players.filter((p) => p.teamIndex === 0 && !p.isSpectator).map((p) => p.playerId);
  const team1Ids = matchConfig.players.filter((p) => p.teamIndex === 1 && !p.isSpectator).map((p) => p.playerId);
  const winnerIds = winnerTeam === 0 ? team0Ids : team1Ids;
  const loserIds = winnerTeam === 0 ? team1Ids : team0Ids;

  // Resolve characters for stat attribution (match_characters, then connections).
  const chars = new Map<string, string>();
  try {
    const matchCharsRaw = await redisClient.get(`match_characters:${setId}`);
    const matchChars = matchCharsRaw ? JSON.parse(matchCharsRaw) : {};
    for (const pid of [...winnerIds, ...loserIds]) {
      if (matchChars[pid]) {
        chars.set(pid, matchChars[pid]);
        continue;
      }
      try {
        const conn = (await redisClient.hGetAll(`connections:${pid}`)) as any;
        if (conn?.character) chars.set(pid, conn.character);
      } catch {}
    }
  } catch {}

  await processSetResult(winnerIds, loserIds, matchConfig.mode, [0, 0] as [number, number], winnerTeam, true, chars, matchId, true);
  await redisClient.publish("ranked_set:fullrankupdate", JSON.stringify({ playerIds: matchConfig.players.map((p) => p.playerId) }));
  logger.info(`${logPrefix} ${leaverId} forfeited match ${matchId} (${reason}) — ELO processed, winner team ${winnerTeam}`);

  // Clean up set state, reset statuses, notify the winner(s).
  const allSetPlayerIds = matchConfig.players.filter((p) => !p.isSpectator).map((p) => p.playerId);
  for (const pid of allSetPlayerIds) await redisClient.del(`player_ranked_set:${pid}`);
  if (setId !== matchId) {
    await redisClient.del(`ranked_set:${setId}`);
    await redisClient.del(`ranked_set_checkins:${setId}`);
  }
  for (const pid of allSetPlayerIds) {
    try {
      await redisUpdatePlayerStatus(pid, "idle");
    } catch (e) {
      logger.error(`${logPrefix} Error resetting status for ${pid}: ${e}`);
    }
    if (pid === leaverId) continue;
    try {
      await redisPushDLLNotification(pid, {
        type: "match_cancel",
        title: "Match Won",
        message: "Opponent left the match",
        data: { matchId, reason: "opponent_dodge" },
        timestamp: Date.now(),
      });
    } catch (e) {
      logger.error(`${logPrefix} Error pushing forfeit notif to ${pid}: ${e}`);
    }
  }
  return true;
}
