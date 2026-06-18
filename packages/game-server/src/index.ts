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
