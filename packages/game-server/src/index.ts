// Public surface of the Awalé game server.

export { Match, type MatchConfig, type Transcript } from "./match.js";
export { GameHub } from "./hub.js";
export { Matchmaker, type Player, type Pairing, type MatchmakerOptions } from "./matchmaking.js";
export { expectedScore, updateElo, scoreForWinner } from "./elo.js";
export {
  moveDigest,
  resultDigest,
  recoverMoveSigner,
  type MoveContext,
  type ResultContext,
} from "./eip712.js";
export { SettlementClient, type SettlementClientOptions } from "./chain.js";
export { attachSocketIO, type ServerDeps } from "./server.js";
export {
  openMatchFromChain,
  watchMatchJoined,
  type ChainMatch,
  type MatchContext,
  type EventWatcher,
} from "./listener.js";
export {
  keeperActions,
  runKeeper,
  EscrowStatus,
  type KeeperMatch,
  type KeeperAction,
} from "./keeper.js";
export type { MatchSnapshot } from "./match.js";
export {
  type LiveMatchStore,
  type LeaderboardStore,
  type PlayerRating,
  type MatchResult,
  DEFAULT_ELO,
  newRating,
} from "./store/types.js";
export { InMemoryLiveMatchStore, InMemoryLeaderboardStore } from "./store/memory.js";
export { RedisLiveMatchStore, type RedisLike } from "./store/redis.js";
export { PgLeaderboardStore, type PgLike, SCHEMA } from "./store/postgres.js";
export { snapshotToJson, snapshotFromJson } from "./store/serialize.js";
export { applyMatchResult } from "./rating.js";
export { normalizePhone, isValidE164 } from "./identity/phone.js";
export {
  CachedNameService,
  nameLookupHandler,
  type NameResolver,
  type NameResult,
  type NameServiceOptions,
} from "./identity/names.js";
export { ODIS_CONFIG, createOdisResolver } from "./identity/odis.js";
